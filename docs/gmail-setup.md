# Connecting Gmail

Ledger sends from **your own Google mailbox** rather than a service address, so
sent mail lands in your Sent folder and a consultant's reply comes back to a
person. That needs an OAuth client, which only you can create — Google ties it
to your account.

Until this is done everything works in **dry run**: emails are composed,
attached to, previewed and logged, and nothing leaves the machine.

This guide is written for the setup you have: **`bookkeepingpoint.com` as a
Google Workspace domain**, with the app **running on localhost** for now. The
last section covers what changes when you deploy to a real domain.

## 1. Create the OAuth client

In the [Google Cloud console](https://console.cloud.google.com/):

1. Create a project (or pick an existing one).
2. **APIs & Services → Library** → enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen** → **Internal**.

   Internal is the reason this is a short setup. The app is usable only by
   accounts in your own Workspace domain, so Google asks for no verification
   review, keeps no test-user list, and the grant does not expire after seven
   days the way an External app in Testing does.

4. Scopes: add **`https://www.googleapis.com/auth/gmail.send`**.

   That is the only sensitive scope. The consent request also carries `openid`
   and `email`, which Google treats as non-sensitive and which exist so Ledger
   can record _which_ address you connected. Ledger asks for no read scope, so
   it cannot see your mail.

5. **Credentials → Create credentials → OAuth client ID → Web application**.
6. Under **Authorised redirect URIs**, add exactly:

   ```
   http://localhost:3000/api/email/google/callback
   ```

   Exactly means the scheme, the port and the path all match. Google compares
   the string, not the destination.

7. Copy the **Client ID** and **Client secret**.

## 2. Set the environment

In `.env`:

```bash
AUTH_GOOGLE_ID="…apps.googleusercontent.com"
AUTH_GOOGLE_SECRET="…"

# Refresh tokens are not stored without this. Generate your own:
#   openssl rand -base64 32
TOKEN_ENCRYPTION_KEY="…"

# Keep this true until you have sent a test and are happy.
EMAIL_DRY_RUN="true"
```

Generate the key yourself rather than using one from anywhere else — it is what
protects the stored refresh token, and a key that has been in a chat log or a
shared document is not a secret.

## 3. Connect the mailbox

```bash
npm run email:check     # says what is still missing
npm run dev
```

**Settings → Email** prints the exact callback URI the app will send. If a
connect attempt is ever refused, copy the URI from that screen into the console
rather than retyping it — it is derived from the request your browser actually
made, so it is the string Google will be comparing against.

Sign in, then **Settings → Email → Connect Google account**. Google will ask
you to allow Ledger to _send email on your behalf_. The connected address is
shown on that screen afterwards.

## 4. Send a real test

```bash
# Still in dry run: composes and logs, sends nothing.
npm run email:check you@example.com
```

Then set `EMAIL_DRY_RUN="false"`, restart, and run it again. The message should
arrive, and appear in your Gmail Sent folder. The Email log screen records the
attempt either way.

Once that works, **Work orders → Send in bulk** goes out through the same path.

## If something goes wrong

| What you see                  | What it means                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `redirect_uri_mismatch`       | The URI in the console does not match the one shown on Settings → Email, character for character — check the port and the trailing path |
| `Error 403: org_internal`     | The Google account you are signing in with is not in the `bookkeepingpoint.com` Workspace. An Internal app admits only your own domain  |
| "reconnect required" banner   | The grant was revoked or the refresh token no longer works — reconnect under Settings → Email                                           |
| Mail logged but never arrives | `EMAIL_DRY_RUN` is still `true`                                                                                                         |
| `403 insufficient scope`      | The consent screen is missing `gmail.send`; add it and reconnect                                                                        |

Ledger asks for consent on every connect (`prompt=consent`), so Google always
returns a refresh token — you should not hit the "already granted, no refresh
token" trap that bites apps which ask only once.

## Limits worth knowing

Google Workspace allows roughly 2,000 recipients a day. Ledger throttles a bulk
send and caps a batch at 200 emails, but a very large month could still hit the
daily figure — the email log will show exactly which messages were rejected,
and "retry failed only" re-sends just those.

## When you deploy

Add the deployed callback alongside the localhost one in the same OAuth client;
both can be registered at once, and the app picks whichever matches where it is
running:

```
https://your-domain/api/email/google/callback
```

Google will not accept a bare IP address as a redirect URI, so a VPS needs a
hostname before the connect flow will work there. Until DNS exists you can
still connect through an SSH tunnel, which makes the app reachable on
`localhost:3000` and matches the URI you already registered.
