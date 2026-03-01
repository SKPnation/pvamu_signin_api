import {onSchedule} from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import {sendEmail} from "../services/email";

admin.initializeApp();

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const BATCH_LIMIT = 450;

type EmailJob = { to: string; subject: string; text: string };

async function processHistoryAutoSignOut(
  historyColl: "tutor_login_history" | "student_login_history",
  mainColl: "tutors" | "students",
  idField: "tutor_id" | "student_id"
): Promise<void> {
  const db = admin.firestore();
  const nowTs = admin.firestore.Timestamp.now();
  const eightHoursAgo = nowTs.toMillis() - EIGHT_HOURS_MS;

  const staleSessions = await db.collection(historyColl)
    .where("time_out", "==", null)
    .where("time_in", "<=", admin.firestore.Timestamp.fromMillis(eightHoursAgo))
    .limit(BATCH_LIMIT)
    .get();

  if (staleSessions.empty) return;

  const batch = db.batch();
  const emailsToSend: EmailJob[] = [];

  for (const sessionDoc of staleSessions.docs) {
    const sessionData = sessionDoc.data();
    const userId = sessionData[idField];

    // 1. Close history
    batch.update(sessionDoc.ref, {
      time_out: nowTs,
      last_sign_out: "auto",
    });

    // 2. Sync main doc
    const mainDocRef = db.collection(mainColl).doc(userId);
    const mainDoc = await mainDocRef.get();

    if (mainDoc.exists) {
      const mainData = mainDoc.data() as {
        time_out?: admin.firestore.Timestamp |
        null; time_in?: admin.firestore.Timestamp;
        email?: string; [key: string]: unknown
      };
      if (mainData?.time_out == null &&
        mainData?.time_in === sessionData.time_in) {
        batch.update(mainDocRef, {
          time_out: nowTs,
          last_sign_out: "auto",
        });
      }

      if (mainData?.email) {
        emailsToSend.push({
          to: mainData.email,
          subject: "Signed out successfully",
          text: `You were automatically signed out at ${nowTs
            .toDate()
            .toLocaleString()}.`,
        });
      }
    }
  }

  await batch.commit();

  for (const e of emailsToSend) {
    try {
      await sendEmail(e);
    } catch (err) {
      console.error(err);
    }
  }
}

export const autoSignOutDaily = onSchedule(
  {schedule: "every 1 hour", secrets: ["RESEND_API_KEY", "RESEND_FROM"]},
  async () => {
    await processHistoryAutoSignOut(
      "tutor_login_history", "tutors", "tutor_id");
    await processHistoryAutoSignOut(
      "student_login_history", "students", "student_id");
  }
);
