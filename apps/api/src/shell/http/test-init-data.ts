// Helper for integration tests: signs MAX launch data (initData) the way the MAX client does, so a test calls
// the mini-app API as a verified user (https://dev.max.ru/docs/webapps/validation). Not part of the build.
import { createHmac } from 'node:crypto';

/** initData of `userId` signed with `botToken`; `authDate` is the launch time in Unix seconds. */
export function signInitData(botToken: string, userId: number, authDate: number): string {
  const fields: Record<string, string> = { auth_date: String(authDate), user: JSON.stringify({ id: userId }) };
  const check = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}
