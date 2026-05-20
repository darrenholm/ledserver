import { Resend } from 'resend';
import { config } from '../config';

const resend = config.email.resendApiKey ? new Resend(config.email.resendApiKey) : null;

interface SendArgs {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

/**
 * Send an email via Resend. If RESEND_API_KEY isn't configured, the call is
 * logged and resolves successfully — useful for local dev and for shipping
 * before the production key is wired up.
 */
export async function sendEmail({ to, subject, html, text, replyTo }: SendArgs): Promise<void> {
  if (!resend) {
    // eslint-disable-next-line no-console
    console.log(`[email] (no RESEND_API_KEY set) → to=${Array.isArray(to) ? to.join(',') : to} subject="${subject}"`);
    return;
  }
  try {
    await resend.emails.send({
      from: config.email.fromAddress,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
      replyTo,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[email] send failed:', err);
  }
}

// --- Templates ---

interface NewRentalArgs {
  rentalId: string;
  approvalToken: string;
  advertiserName: string;
  advertiserEmail: string;
  advertiserBusiness?: string | null;
  advertiserNotes?: string | null;
  deviceName: string;
  deviceLocation?: string | null;
  startDate: string;
  endDate: string;
  amountFormatted: string;
  artworkPreviewUrl?: string | null;
  artworkWarnings: string[];
}

export function newRentalEmail(args: NewRentalArgs): { subject: string; html: string; text: string } {
  const approveUrl = `${config.publicBaseUrl}/api/rentals/approve/${args.approvalToken}`;
  const rejectUrl = `${config.publicBaseUrl}/api/rentals/reject/${args.approvalToken}`;
  const adminUrl = `${config.publicBaseUrl}/rentals/${args.rentalId}`;

  const warnings = args.artworkWarnings.length
    ? `<p style="color:#d97706"><strong>Artwork warnings:</strong> ${args.artworkWarnings.map((w) => escapeHtml(w)).join(', ')}</p>`
    : '';

  const preview = args.artworkPreviewUrl
    ? `<p><img src="${args.artworkPreviewUrl}" alt="artwork" style="max-width:480px;border:1px solid #ddd;border-radius:4px"/></p>`
    : '';

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#111;line-height:1.4">
      <h2>New rental request</h2>
      <p><strong>${escapeHtml(args.advertiserName)}</strong>${args.advertiserBusiness ? ' (' + escapeHtml(args.advertiserBusiness) + ')' : ''} wants to rent <strong>${escapeHtml(args.deviceName)}</strong>${args.deviceLocation ? ' — ' + escapeHtml(args.deviceLocation) : ''}.</p>
      <ul>
        <li><strong>Window:</strong> ${args.startDate} → ${args.endDate}</li>
        <li><strong>Total:</strong> ${args.amountFormatted}</li>
        <li><strong>Email:</strong> ${escapeHtml(args.advertiserEmail)}</li>
        ${args.advertiserNotes ? `<li><strong>Notes:</strong> ${escapeHtml(args.advertiserNotes)}</li>` : ''}
      </ul>
      ${preview}
      ${warnings}
      <p style="margin:24px 0">
        <a href="${approveUrl}" style="display:inline-block;padding:10px 18px;background:#16a34a;color:white;border-radius:6px;text-decoration:none;margin-right:8px">Approve &amp; publish</a>
        <a href="${rejectUrl}" style="display:inline-block;padding:10px 18px;background:#dc2626;color:white;border-radius:6px;text-decoration:none">Reject</a>
      </p>
      <p style="font-size:13px;color:#666">Or open the full review page: <a href="${adminUrl}">${adminUrl}</a></p>
    </div>
  `;

  const text = `New rental request from ${args.advertiserName} for ${args.deviceName}.
Window: ${args.startDate} → ${args.endDate}
Total: ${args.amountFormatted}
Approve: ${approveUrl}
Reject: ${rejectUrl}
Review: ${adminUrl}
`;

  return { subject: `New ad rental — ${args.deviceName}`, html, text };
}

interface SimpleRentalArgs {
  rentalId: string;
  advertiserName: string;
  deviceName: string;
  startDate: string;
  endDate: string;
  notes?: string | null;
}

export function rentalApprovedEmail(a: SimpleRentalArgs): { subject: string; html: string; text: string } {
  const statusUrl = `${config.publicBaseUrl}/rent/orders/${a.rentalId}`;
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#111;line-height:1.4">
      <h2>Your ad is approved</h2>
      <p>Hi ${escapeHtml(a.advertiserName)},</p>
      <p>Your artwork has been approved and will run on <strong>${escapeHtml(a.deviceName)}</strong> from <strong>${a.startDate}</strong> to <strong>${a.endDate}</strong>.</p>
      <p><a href="${statusUrl}">View your booking</a></p>
    </div>
  `;
  return {
    subject: `Your ad on ${a.deviceName} is approved`,
    html,
    text: `Your artwork is approved. It will run on ${a.deviceName} from ${a.startDate} to ${a.endDate}.\n${statusUrl}`,
  };
}

export function rentalRejectedEmail(a: SimpleRentalArgs): { subject: string; html: string; text: string } {
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#111;line-height:1.4">
      <h2>Your ad submission was not approved</h2>
      <p>Hi ${escapeHtml(a.advertiserName)},</p>
      <p>Unfortunately we couldn't approve your artwork for <strong>${escapeHtml(a.deviceName)}</strong>.</p>
      ${a.notes ? `<p><strong>Reason:</strong> ${escapeHtml(a.notes)}</p>` : ''}
      <p>Any payment will be refunded within 3–5 business days. Reach out to us if you'd like to submit revised artwork.</p>
    </div>
  `;
  return {
    subject: `Your ad submission for ${a.deviceName} was not approved`,
    html,
    text: `Your submission for ${a.deviceName} was not approved.${a.notes ? `\nReason: ${a.notes}` : ''}`,
  };
}

interface UserInviteArgs {
  inviterName: string;
  organizationName: string;
  role: string;
  token: string;
  expiresAt: Date;
}

export function userInviteEmail(args: UserInviteArgs): { subject: string; html: string; text: string } {
  const acceptUrl = `${config.publicBaseUrl}/accept-invite?token=${encodeURIComponent(args.token)}`;
  const expiresStr = args.expiresAt.toLocaleString('en-CA', { dateStyle: 'long', timeStyle: 'short' });
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#111;line-height:1.4">
      <h2>You've been invited to ${escapeHtml(args.organizationName)} on LED Server</h2>
      <p>${escapeHtml(args.inviterName)} has invited you to join <strong>${escapeHtml(args.organizationName)}</strong> as <code>${escapeHtml(args.role)}</code>.</p>
      <p style="margin:24px 0">
        <a href="${acceptUrl}" style="display:inline-block;padding:10px 18px;background:#16a34a;color:white;border-radius:6px;text-decoration:none">Accept invitation</a>
      </p>
      <p style="font-size:13px;color:#666">This link expires on ${escapeHtml(expiresStr)}. If you weren't expecting this, you can ignore the email — no account is created until you accept.</p>
    </div>
  `;
  const text = `${args.inviterName} invited you to join ${args.organizationName} on LED Server as ${args.role}.
Accept: ${acceptUrl}
Link expires ${expiresStr}.`;
  return {
    subject: `Invitation to ${args.organizationName} on LED Server`,
    html,
    text,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
