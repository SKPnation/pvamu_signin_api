import {defineSecret} from "firebase-functions/params";
import {logger} from "firebase-functions";

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
const RESEND_FROM = defineSecret("RESEND_FROM");

export type EmailPayload = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
};

export async function sendEmail(payload: EmailPayload): Promise<void> {
  const {to, subject, text, html} = payload;

  if (!to || !subject || (!text && !html)) {
    throw new Error("to, subject, and text or html are required.");
  }

  const {Resend} = await import("resend");
  const resend = new Resend(RESEND_API_KEY.value());

  const base = {
    from: RESEND_FROM.value(),
    to,
    subject,
  };

  if (html) {
    await resend.emails.send({...base, html});
  } else if (text) {
    await resend.emails.send({...base, text});
  } else {
    throw new Error("Either html or text must be provided.");
  }

  logger.info("Resend email sent", {to, subject});
}
