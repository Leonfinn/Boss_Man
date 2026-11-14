---
title: Outgoing email
description: Let Boss Man send email through Proton Mail or Cloudflare Email Service, with the SPF, DKIM and DMARC records that keep it out of spam.
group: Set it up your way
order: 14
lead: Boss Man can send email through any mail service that offers authenticated SMTP. This guide sets it up with Proton Mail or Cloudflare Email Service, adds the DNS records that keep the mail out of spam, and sends a test.
time: About 30 minutes, plus time for DNS changes to spread. You need your own domain and access to its DNS settings.
---

## What you need

:::note Before you start
- A domain you own, such as `example.com`, and access to its DNS records.
- One of the two senders below, on a paid plan.
- The Boss Man owner login. Only the owner can see the outgoing email settings.
:::

The short version:

1. Pick a sender and get its SMTP details: [Proton Mail](#proton-mail) or [Cloudflare Email Service](#cloudflare-email-service).
2. Add the [SPF, DKIM and DMARC records](#spf-dkim-and-dmarc) for the sending domain.
3. Fill in **Settings → Server and runner → Outgoing email** in Boss Man and [send a test email](#fill-in-boss-man-s-settings).

## Choose a sender

Both work with Boss Man. Pick the one that fits how your domain already handles mail.

| | Proton Mail | Cloudflare Email Service |
|---|---|---|
| Plan | Any paid Proton Mail plan with a custom domain | Workers Paid. Sending is in beta |
| Server | `smtp.protonmail.ch` | `smtp.mx.cloudflare.net` |
| Port and security | 587, STARTTLS | 465, TLS from the start |
| Username | The address the token belongs to | The word `api_token` |
| Password | An SMTP token, one per address | A Cloudflare API token |
| Works beside Cloudflare Email Routing on the same domain | No: see [the one-MX catch](#the-one-mx-catch) | Yes |

**Cloudflare Email Routing on its own cannot send.** It receives mail for your domain and forwards it to another mailbox. To send from Cloudflare you need Email Sending, which is part of Cloudflare Email Service.

### Proton Mail

Proton Mail's SMTP submission sends mail from one of your custom-domain addresses. It needs a paid plan, and the address must be on a custom domain, not `@proton.me`.

1. In Proton Mail, open **Settings → All settings → IMAP/SMTP → SMTP tokens**.
2. Choose **Generate token**. Give it a name you will recognise, such as `Boss Man`, and pick the address Boss Man will send from.
3. Choose **Generate** and enter your Proton password.
4. Copy the token now. Proton shows it once only.

Each token belongs to one address. If you want Boss Man to send from a different address, make a new token for that address.

Your Proton login password does not work for SMTP. Use the token.

### Cloudflare Email Service

Cloudflare's Email Sending is in beta and needs the Workers Paid plan. Your domain must already use Cloudflare for its DNS.

1. In the Cloudflare dashboard, go to **Compute → Email Service → Email Sending** and choose **Onboard Domain**. Pick your domain and choose **Done**. Cloudflare adds the sending records for you (see [SPF, DKIM and DMARC](#spf-dkim-and-dmarc)).
2. Make a Cloudflare API token with the **Email Sending: Edit** permission. Copy it. This token is Boss Man's password, and anyone who has it can send mail from your domain.

Cloudflare only accepts mail on port 465 with TLS from the start. STARTTLS on port 587 does not work there.

## The one-MX catch

A domain's MX records say which service receives its mail. A domain can only have one receiving service.

This matters if you choose Proton Mail and your domain already receives mail through Cloudflare Email Routing. Proton wants its own MX records on any domain you add to it, and Cloudflare Email Routing will not run beside another provider's MX records. You have two ways out:

- **Send from a subdomain hosted at Proton.** Add a subdomain such as `notify.example.com` to Proton as its own custom domain, with its own MX, SPF, DKIM and DMARC records, and send from an address on it, such as `boss@notify.example.com`. `example.com` itself keeps Cloudflare Email Routing. *Unverified:* Proton's help pages do not say outright that a subdomain can be a custom domain, or whether it counts towards your plan's domain limit. If Proton refuses it, use the next option or Cloudflare.
- **Move the domain's mail to Proton.** Replace Cloudflare's MX records with Proton's and turn off Email Routing. Proton then receives all mail for the domain.

Cloudflare Email Service does not have this catch. Its sending records live on a separate `cf-bounce` subdomain, so Email Sending and Email Routing work side by side on the same domain.

## SPF, DKIM and DMARC

Mail services check these three DNS records before they trust a message. Without them, Boss Man's mail will probably land in spam or be refused.

| Record | What it is for | Where it goes |
|---|---|---|
| SPF | Lists the servers allowed to send mail for the domain | A TXT record on the sending domain |
| DKIM | Signs each message, so a receiver can tell it came from you and was not changed | Proton: three CNAME records. Cloudflare: one TXT record on `cf-bounce._domainkey` |
| DMARC | Tells receivers what to do with mail that fails SPF and DKIM, and where to send reports | A TXT record on `_dmarc` |

### With Proton Mail

In Proton Mail, open **Settings → All settings → Domain names** and choose **Review** next to your domain. The **SPF**, **DKIM** and **DMARC** tabs show the exact records to add. Copy them into your DNS settings.

- **SPF**: a domain can have only one SPF record. If you already have one, add `include:_spf.protonmail.ch` to it after `v=spf1`, instead of adding a second record.
- **DKIM**: add all three CNAME records. Proton uses them to change its keys by itself. If your DNS service does not accept a value ending in a dot, remove the dot.
- **DMARC**: Proton suggests `p=quarantine`. You can start with `p=none`, which only reports, and tighten it once your mail passes.

### With Cloudflare Email Service

Onboarding the domain in step 1 adds the records for you:

- MX and SPF (`v=spf1 include:_spf.mx.cloudflare.net ~all`) on `cf-bounce.example.com`
- DKIM on `cf-bounce._domainkey.example.com`
- DMARC on `_dmarc.example.com`, set to `p=reject`

A domain should have only one DMARC record. If you already had one, check which one is left.

### Check the records

- **Proton Mail**: each tab under **Domain names → Review** shows a green tick once Proton finds the record.
- **Cloudflare**: go to **Compute → Email Service → Email Sending → Settings**. The **DNS records** section lists each sending record.

DNS changes usually show within minutes but can take up to 24 hours. On a computer with `dig`, you can look at a record yourself:

```sh Run on any computer with dig
dig +short TXT example.com
dig +short TXT _dmarc.example.com
```

Replace `example.com` with your sending domain. For Cloudflare, also check `cf-bounce.example.com` and `cf-bounce._domainkey.example.com`.

## Fill in Boss Man's settings

1. In Boss Man, open **Settings → Server and runner** and go to **Outgoing email**. You can jump there from the list at the top of the page.
2. Fill in the fields as the table below shows.
3. Choose **Save**. The button stays greyed out until **Server**, **Port** and **From address** are filled in.

| Field | Proton Mail | Cloudflare Email Service |
|---|---|---|
| **Server** | `smtp.protonmail.ch` | `smtp.mx.cloudflare.net` |
| **Port** | `587` | `465` |
| **Security** | **STARTTLS (usually port 587)** | **TLS from the start (usually port 465)** |
| **Username** | The address the token belongs to, such as `boss@example.com` | `api_token` |
| **Password or token** | The SMTP token | The Cloudflare API token |
| **From address** | The same address as **Username** | An address on the domain you onboarded, such as `boss@example.com` |
| **From name (optional)** | The name people see, such as `Boss Man` | The same |

:::worked
The section starts with "Outgoing email is on." and a **Send a test email to** box appears.
:::

Boss Man keeps the password in its encrypted secret store and never shows it again. The box then says "Saved (type to replace)". Leave it empty to keep the saved password, or type a new one to replace it.

**Security: None (not encrypted)** sends the password and the mail across the network unprotected. Use it only for a mail server on a network you trust.

### Send a test email

1. In **Send a test email to**, type an address you can read.
2. Choose **Send test email**. The test uses the saved settings, so save first.

:::worked
Boss Man says "Sent." and a message headed "Boss Man test email" arrives. Check the spam folder too. If it landed there, check your [SPF, DKIM and DMARC records](#check-the-records).
:::

To stop sending, choose **Turn off**. Boss Man forgets the settings and removes the saved password.

### If the test fails

Boss Man shows the mail server's own answer after "The test email didn't go through:". The usual ones:

- **"The mail server refused the login: 535 …"**: the username or password is wrong. For Proton, the username is the token's address and the password is the token, not your Proton password. For Cloudflare, the username is `api_token` and the token needs **Email Sending: Edit**.
- **"The server doesn't offer STARTTLS on this port."**: the port wants TLS from the start. For Cloudflare, use port `465` with **TLS from the start**.
- **"The mail server didn't answer within 20 seconds."**: the server name, port or security choice is wrong, or something between Boss Man and the internet blocks that port.
- **"The mail server refused the sender address: …"**: the **From address** is not one the service lets you send from. For Proton, use the token's address. For Cloudflare, onboard the address's domain under Email Sending.

## Worked example: Cloudflare DNS with Proton Mail

Say your domain `example.com` uses Cloudflare for DNS, Cloudflare Email Routing forwards its mail to your inbox, and you pay for Proton Mail.

Because Email Routing already receives for `example.com`, Proton cannot take over that domain's MX records without ending Email Routing. Pick one:

- **Keep Email Routing and use Proton on a subdomain.** Add `notify.example.com` to Proton, put Proton's MX, SPF, DKIM and DMARC records for it in Cloudflare's DNS, make `boss@notify.example.com` in Proton, and generate an SMTP token for it. In Boss Man: **Server** `smtp.protonmail.ch`, **Port** `587`, **Security** STARTTLS, **Username** and **From address** `boss@notify.example.com`, **Password or token** the token. See the *Unverified* note in [the one-MX catch](#the-one-mx-catch).
- **Keep Email Routing and send with Cloudflare instead.** Onboard `example.com` under Email Sending (Workers Paid), make an API token, and fill in Boss Man with the Cloudflare column above. Proton is not involved.
- **Move all mail to Proton.** Swap Cloudflare's MX records for Proton's, turn off Email Routing, and fill in Boss Man with the Proton column using an `@example.com` address.

## What uses outgoing email

Nothing in Boss Man needs outgoing email yet. The feedback portal's email confirmation will use it once that feature is released, and this guide will gain a section on it then.
