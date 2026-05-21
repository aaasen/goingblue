export const LOCATION_DISPLAY_NAMES = ["Current location", "11k", "14k", "17k", "Summit", "Airstrip"];

export const WMO: Record<number, [string, string, string]> = {
  0: ["Clear sky", "Clear", "☀️"],
  1: ["Mainly clear", "Mainly clear", "🌤️"],
  2: ["Partly cloudy", "Partly cloudy", "⛅"],
  3: ["Overcast", "Overcast", "☁️"],
  45: ["Fog", "Fog", "🌫️"],
  48: ["Rime fog", "Rime fog", "🌫️"],
  51: ["Light drizzle", "Lt drizzle", "🌦️"],
  53: ["Moderate drizzle", "Drizzle", "🌦️"],
  55: ["Dense drizzle", "Dense drizzle", "🌦️"],
  56: ["Lt freezing drizzle", "Frz drizzle", "🌨️"],
  57: ["Hvy freezing drizzle", "Frz drizzle", "🌨️"],
  61: ["Slight rain", "Light rain", "🌧️"],
  63: ["Moderate rain", "Rain", "🌧️"],
  65: ["Heavy rain", "Heavy rain", "🌧️"],
  66: ["Lt freezing rain", "Frz rain", "🌨️"],
  67: ["Hvy freezing rain", "Frz rain", "🌨️"],
  71: ["Slight snow", "Light snow", "❄️"],
  73: ["Moderate snow", "Snow", "❄️"],
  75: ["Heavy snow", "Heavy snow", "❄️"],
  77: ["Snow grains", "Snow grains", "🌨️"],
  80: ["Slight showers", "Showers", "🌧️"],
  81: ["Moderate showers", "Showers", "🌧️"],
  82: ["Violent showers", "Hvy showers", "🌧️"],
  85: ["Slight snow showers", "Snow showers", "🌨️"],
  86: ["Heavy snow showers", "Snow showers", "🌨️"],
  95: ["Thunderstorm", "Thunder", "⛈️"],
  96: ["Thunder + hail", "Thunder/hail", "⛈️"],
  99: ["Thunder + hail", "Thunder/hail", "⛈️"],
};

export const ARROWS: Record<string, string> = {
  N: "↓",
  NE: "↙",
  E: "←",
  SE: "↖",
  S: "↑",
  SW: "↗",
  W: "→",
  NW: "↘",
};

// [mph upper bound, label, bg, fg]
export const BEAUFORT: [number, string, string, string][] = [
  [1, "Calm", "#7e97a0", "#fff"],
  [4, "Light air", "#7e97a0", "#fff"],
  [8, "Lt breeze", "#82c8ec", "#1a1a1a"],
  [13, "Gentle", "#3a9ecc", "#fff"],
  [19, "Moderate", "#3a9e88", "#fff"],
  [25, "Fresh", "#4a9e30", "#fff"],
  [32, "Strong", "#d47810", "#fff"],
  [39, "Near gale", "#9e2818", "#fff"],
  [47, "Gale", "#dd0028", "#fff"],
  [55, "Strong gale", "#8800aa", "#fff"],
  [64, "Storm", "#5030b0", "#fff"],
  [73, "Violent storm", "#006888", "#fff"],
  [Infinity, "Hurricane", "#00cc44", "#fff"],
];

export const MODEL_COLORS: Record<string, string> = {
  "ECMWF IFS HRES": "#2a6bb5",
  GFS: "#2a8f5a",
  ICON: "#c06010",
  "ECMWF IFS 0.25": "#7040b0",
};

// model checkbox value → vars not supported by that model
export const MODEL_UNAVAIL_VARS: Record<string, string[]> = {
  hres: ["freeze", "w500", "w600", "w700"],
  gfs: [],
  icon: [],
  ifs: [],
};
