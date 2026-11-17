export const APP_NAME = "aggregator"; // placeholder; single source for renaming (spec header)
export const CHANNELS = ["airbnb", "vrbo", "booking", "google", "direct", "manual", "other"] as const;
export type Channel = (typeof CHANNELS)[number];
export const PROVIDERS = ["hostaway", "guesty", "google_gbp", "ownerrez", "hospitable", "csv", "direct"] as const;
export type Provider = (typeof PROVIDERS)[number];
