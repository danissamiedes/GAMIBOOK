# Connecting Gmail

Ledger sends from **your own Google mailbox** rather than a service address, so
sent mail lands in your Sent folder and a consultant's reply comes back to a
person. That needs an OAuth client, which only you can create — Google ties it
to your account.

Until this is done everything works in **dry run**: emails are composed,
attached to, previewed and logged, and nothing leaves the machine.

## 1. Create the OAuth client

In the [Google Cloud console](https://console.cloud.google.com/):

1. Create a project (or pick an existing one).
2. **APIs & Services → Library** → enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen**:
   - If `bookkeepingpoint.com` is a Google Workspace domain, choose **Internal**.
     Nothing needs verifying and only your own people can use it.
   - If it is a personal Gmail account, choose **External** and add yourself as
     a test user. Google's verification review is only needed if you later
     publish it to people outside that list.
   - Scope: add **`https://www.googleapis.com/auth/gmail.send`** and nothing
     else. Ledger cannot read mail, and asking for a read scope would make the
     review harder for no gain.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
5. Under **Authorised redirect URIs**, add the callback for wherever the app
   runs — both, if you use both:

   ```
   http://localhost:3000/api/email/google/callback
   https://YOUR-DOMAIN/api/email/google/callback
   ```

   It must match exactly, including `https` and any port.
6. Copy the **Client ID** and **Client secret**.

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

Sign in, then **Settings → Email → Connect Google account**. Google will ask
you to allow Ledger to *send email on your behalf*. The connected address is
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

| What you see | What it means |
|---|---|
| `redirect_uri_mismatch` | The URI in the console does not exactly match where the app is running |
| "Google did not return a refresh token" | The account has already granted access. Remove Ledger at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and connect again |
| "reconnect required" banner | The grant was revoked or expired — reconnect under Settings → Email |
| Mail logged but never arrives | `EMAIL_DRY_RUN` is still `true` |
| `403 insufficient scope` | The consent screen is missing `gmail.send`; add it and reconnect |

## Limits worth knowing

Google Workspace allows roughly 2,000 recipients a day, consumer Gmail about
500. Ledger throttles a bulk send and caps a batch at 200 emails, but a very
large month could still hit the daily figure — the email log will show exactly
which messages were rejected, and "retry failed only" re-sends just those.
