// Signs MAX mini-app launch data for a test user, so the API can be checked without the MAX client:
//   MAX_BOT_TOKEN=... node dist/scripts/sign-init-data.js 1000001
// Prints the value for the X-Max-Init-Data header. It is valid for INIT_DATA_MAX_AGE_SECONDS on the server.
import { createHmac } from 'node:crypto';

const userId = Number(process.argv[2]);
const token = process.env.MAX_BOT_TOKEN;
if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('usage: sign-init-data <maxUserId>');
if (!token) throw new Error('MAX_BOT_TOKEN is required');

const fields: Record<string, string> = {
  auth_date: String(Math.floor(Date.now() / 1000)),
  query_id: `review-${userId}`,
  user: JSON.stringify({ id: userId, first_name: 'Проверка' }),
};
const dataCheckString = Object.keys(fields)
  .sort()
  .map((key) => `${key}=${fields[key]}`)
  .join('\n');
const secret = createHmac('sha256', 'WebAppData').update(token).digest();
const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');

console.log(new URLSearchParams({ ...fields, hash }).toString());
