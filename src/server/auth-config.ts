import { betterAuth } from "better-auth";
import { db } from "./db";

const secret = process.env.BETTER_AUTH_SECRET;
const baseURL = process.env.BETTER_AUTH_URL;
if (!secret || secret.length < 32)
  throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
if (!baseURL) throw new Error("BETTER_AUTH_URL is required.");
const url = new URL(baseURL);
if (!["http:", "https:"].includes(url.protocol))
  throw new Error("Invalid BETTER_AUTH_URL.");
export const auth = betterAuth({
  database: db,
  secret,
  baseURL,
  trustedOrigins: [url.origin],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
  },
  session: { cookieCache: { enabled: false } },
});
