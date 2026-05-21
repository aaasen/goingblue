import { parse } from "node-html-parser";

export function parseReplyPage(html: string): { guid: string; messageId: string } | null {
  const doc = parse(html);
  const guid = doc.querySelector("#Guid")?.getAttribute("value");
  const messageId = doc.querySelector("#MessageId")?.getAttribute("value");
  if (!guid || !messageId) return null;
  return { guid, messageId };
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  DNT: "1",
};

export async function sendGarminReply(
  replyUrl: string,
  replyAddress: string,
  message: string,
): Promise<boolean> {
  console.log("garmin: fetching reply page", replyUrl);
  const pageResp = await fetch(replyUrl, { headers: BROWSER_HEADERS });
  const pageText = await pageResp.text();
  console.log("garmin: page status=%d final_url=%s", pageResp.status, pageResp.url);

  // Forward session cookies to the POST request
  const setCookies: string[] =
    (pageResp.headers as unknown as { getSetCookie?(): string[] }).getSetCookie?.() ?? [];
  const cookieHeader = setCookies.map((c) => c.split(";")[0]).join("; ");

  const parsed = parseReplyPage(pageText);
  if (!parsed) {
    console.error(`garmin: Guid not found in page (len=${pageText.length})`);
    console.debug("garmin: page body:", pageText.slice(0, 2000));
    return false;
  }

  const { guid, messageId } = parsed;
  console.log("garmin: guid=%s message_id=%s", guid, messageId);

  const baseUrl = pageResp.url.split("/textmessage")[0];
  const apiUrl = `${baseUrl}/TextMessage/TxtMsg`;
  console.log("garmin: posting to %s (message len=%d)", apiUrl, message.length);

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      ...BROWSER_HEADERS,
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Origin: baseUrl,
      Referer: pageResp.url,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: JSON.stringify({
      ReplyAddress: replyAddress,
      ReplyMessage: message,
      Guid: guid,
      MessageId: messageId,
    }),
  });

  const body = await response.text();
  console.log("garmin: post status=%d body=%s", response.status, body.slice(0, 500));

  let result: unknown;
  try {
    result = JSON.parse(body);
  } catch {
    console.error("garmin: response is not JSON:", body.slice(0, 500));
    return false;
  }

  const success = (result as { Success?: boolean }).Success === true;
  if (!success) console.error("garmin: Success=False, full response:", result);
  return success;
}
