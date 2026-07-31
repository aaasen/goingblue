// tz-lookup ships no types. One function, one job: a coordinate in, an IANA zone name out. It
// throws on coordinates outside the valid ranges and answers "Etc/GMT" over the poles and open
// ocean, where no zone owns the water.
declare module 'tz-lookup' {
  export default function tzlookup(lat: number, lon: number): string;
}
