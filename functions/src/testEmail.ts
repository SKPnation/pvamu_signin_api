import {onRequest} from "firebase-functions/v2/https";
import {defineSecret} from "firebase-functions/params";
import {logger} from "firebase-functions";

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
const RESEND_FROM = defineSecret("RESEND_FROM");

/**
 * Safely checks whether a value has an `error` property
 * without using `any`
 */
function hasError(value: unknown): value is { error: unknown } {
  return typeof value === "object" && value !== null && "error" in value;
}

export const testEmail = onRequest(
  {
    secrets: ["RESEND_API_KEY", "RESEND_FROM"],
    cors: true,
  },
  async (req, res) => {
    try {
      const to = typeof req.body?.to === "string" ? req.body.to.trim() : "";

      if (!to) {
        res.status(400).json({error: "Missing 'to' email"});
        return;
      }

      const {Resend} = await import("resend");
      const resend = new Resend(RESEND_API_KEY.value());

      const from = RESEND_FROM.value();

      const result = await resend.emails.send({
        from,
        to,
        subject: "Test Email",
        text: "This is a test email from Firebase + Resend.",
      });

      // Log full result for Firebase logs
      logger.info("Resend testEmail result", {to, from, result});

      // Handle Resend error response safely
      if (hasError(result) && result.error) {
        res.status(500).json({
          success: false,
          error: "Resend rejected the request",
          result: result.error,
        });
        return;
      }

      res.json({
        success: true,
        from,
        to,
        result, // includes data.id on success
      });
    } catch (err) {
      logger.error("testEmail failed", {error: String(err)});
      res.status(500).json({
        success: false,
        error: "Failed to send email",
        details: String(err),
      });
    }
  }
);
