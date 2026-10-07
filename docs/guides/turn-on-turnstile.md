# Turning on Cloudflare Turnstile for the enquiry form

Turnstile is Cloudflare's free, mostly invisible "are you a person?" check. It's
**already built into the enquiry form and switched off** (ADR 0007). Turning it
on takes about 15 minutes and **no code change**: two keys and one switch in the
API's settings. The website picks it up by itself.

You need: a free Cloudflare account (email + password is enough -- your domain
doesn't have to be on Cloudflare), and access to the API's variables on Railway.

## 1. Create the widget in Cloudflare

1. Sign in at <https://dash.cloudflare.com> (create a free account if needed).
2. In the left menu open **Turnstile**, then **Add widget**.
3. **Widget name:** `Needleye enquiry form`.
4. **Hostnames:** add the website's address without `https://`, e.g.
   `needleye.vercel.app` (and your own domain, if you use one). Add
   `localhost` too if you want to try it on your computer first.
5. **Widget mode:** **Managed** (Cloudflare shows a checkbox only when it's
   unsure; most customers see nothing).
6. **Pre-clearance:** No.
7. Click **Create**. Cloudflare shows two keys:
   - **Site key** (public -- it goes into the page)
   - **Secret key** (private -- treat it like a password; never put it in the
     website's settings or share it in chat).

## 2. Put the keys into the API (Railway)

1. Railway -> the **needleye-api** service -> **Variables**.
2. Add:
   - `TURNSTILE_SITE_KEY` = the site key
   - `TURNSTILE_SECRET_KEY` = the secret key
   - `TURNSTILE_ENABLED` = `true`
3. Save. Railway redeploys the API (about a minute).

The API refuses to start with `TURNSTILE_ENABLED=true` and a missing key, so a
typo can't silently leave the form unprotected -- check the deploy log if it
fails.

## 3. Check it

1. Open the enquiry page (`/enquiry`) in a private/incognito window. A small
   Cloudflare box appears above **Send enquiry** (often it ticks itself).
2. Send a test enquiry -- it should say "Thank you!" and appear under Leads.
3. From your computer, in `needleye-api`:
   `npm run test:public-form -- --base=https://<your-api>/api/v1`
   should still pass (it never stores a lead).

## Turning it off again

Set `TURNSTILE_ENABLED=false` in Railway (keep the keys). The form goes back to
its other protections: rate limits, the hidden bot trap, the timing check and
the 2-per-day rule.

## If customers say the form won't send

- The box says "failed": usually an old browser or a blocked script. Ask them
  to try another browser, or turn Turnstile off for a while.
- The website's address isn't listed under **Hostnames** in Cloudflare (step 1.4).
- Cloudflare itself is down: the API treats that as "not verified" (it fails
  safe). Turn Turnstile off until it recovers.
