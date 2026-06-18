import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// ── Config (set these in Vercel → Project → Settings → Environment Variables) ──
const DOMAIN    = process.env.MAIL_DOMAIN || 'kagom.store';
const IMAP_HOST = process.env.IMAP_HOST   || 'imap.gmail.com';
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const IMAP_USER = process.env.IMAP_USER;   // the Gmail that receives all @kagom.store forwards
const IMAP_PASS = process.env.IMAP_PASS;   // a Gmail "App Password" (not the normal password)

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const address = String(req.query.address || '').trim().toLowerCase();
  if (!address || !address.endsWith('@' + DOMAIN)) {
    return res.status(400).json({ error: 'Enter a valid @' + DOMAIN + ' address' });
  }
  if (!IMAP_USER || !IMAP_PASS) {
    return res.status(500).json({ error: 'Mailbox is not configured on the server yet' });
  }

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
  });

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');

    const emails = [];

    // 1) Fast path: ask the server for messages whose To header contains the address.
    let uids = [];
    try {
      uids = await client.search({ to: address }, { uid: true });
    } catch (_) {
      uids = [];
    }

    if (uids && uids.length) {
      const recent = uids.slice(-25).join(',');
      for await (const msg of client.fetch(recent, { uid: true, source: true, flags: true }, { uid: true })) {
        emails.push(await toEmail(msg));
      }
    } else {
      // 2) Fallback: some forwarders put the address in Delivered-To / X-Forwarded-To
      //    instead of To. Scan the most recent messages and match ourselves.
      const status = await client.status('INBOX', { messages: true });
      const total  = status.messages || 0;
      if (total > 0) {
        const start = Math.max(1, total - 39);
        for await (const msg of client.fetch(`${start}:*`, { source: true, flags: true })) {
          const parsed = await simpleParser(msg.source);
          if (matches(parsed, address)) emails.push(fromParsed(parsed, msg));
        }
      }
    }

    emails.sort((a, b) => new Date(b.date) - new Date(a.date));
    return res.status(200).json({ address, emails: emails.slice(0, 30) });
  } catch (err) {
    console.error('IMAP error:', err);
    return res.status(500).json({ error: 'Could not reach the mailbox' });
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

async function toEmail(msg) {
  const parsed = await simpleParser(msg.source);
  return fromParsed(parsed, msg);
}

function fromParsed(parsed, msg) {
  const body = (parsed.text || stripHtml(parsed.html || '') || '').trim();
  return {
    id:      String(msg.uid || msg.seq || parsed.messageId || Math.random()),
    from:    (parsed.from && parsed.from.text) || '(unknown sender)',
    to:      (parsed.to && parsed.to.text) || '',
    subject: parsed.subject || '(no subject)',
    body,
    date:    (parsed.date || new Date()).toISOString(),
    unread:  msg.flags ? !msg.flags.has('\\Seen') : false,
  };
}

function matches(parsed, address) {
  const hay = [
    parsed.to && parsed.to.text,
    parsed.cc && parsed.cc.text,
    parsed.headers && parsed.headers.get('delivered-to'),
    parsed.headers && parsed.headers.get('x-forwarded-to'),
    parsed.headers && parsed.headers.get('x-original-to'),
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(address);
}

function stripHtml(html) {
  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ').trim();
}
