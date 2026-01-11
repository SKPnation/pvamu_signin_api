import {onSchedule} from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";

admin.initializeApp();

// const FIVE_MINUTES_MS = 5 * 60 * 1000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const BATCH_LIMIT = 450; // keep below 500 safely

type TimestampLike = {toMillis: () => number};

function isTimestampLike(v: unknown): v is TimestampLike {
  return (
    typeof v === "object" &&
    v !== null &&
    "toMillis" in v &&
    typeof (v as Record<string, unknown>).toMillis === "function"
  );
}

function toMillis(v: unknown): number | null {
  if (isTimestampLike(v)) return v.toMillis();
  if (v instanceof Date) return v.getTime();

  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }

  return null;
}

async function processCollection(collectionName: string): Promise<void> {
  const db = admin.firestore();
  let lastDoc: admin.firestore.QueryDocumentSnapshot | null = null;

  const done = false;
  while (!done) {
    // Only docs where time_out is null
    let q: admin.firestore.Query = db
      .collection(collectionName)
      .where("time_out", "==", null)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(1000);

    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    let batch = db.batch();
    let ops = 0;

    const nowTs = admin.firestore.Timestamp.now();
    const nowMs = nowTs.toMillis();

    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;

      const timeInMs = toMillis(data.time_in);

      // Ensure last_sign_out exists if missing (null when not auto)
      const hasLastSignOut = Object.prototype.hasOwnProperty.call(
        data,
        "last_sign_out"
      );

      if (timeInMs == null) {
        if (!hasLastSignOut) {
          batch.set(doc.ref, {last_sign_out: null}, {merge: true});
          ops++;
        }
      } else {
        const shouldAutoSignOut =
          data.time_out == null && nowMs - timeInMs >= EIGHT_HOURS_MS;

        if (shouldAutoSignOut) {
          batch.set(
            doc.ref,
            {
              time_out: nowTs,
              last_sign_out: "auto",
            },
            {merge: true}
          );
          ops++;
        } else if (!hasLastSignOut) {
          batch.set(doc.ref, {last_sign_out: null}, {merge: true});
          ops++;
        }
      }

      // Commit in chunks
      if (ops >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }

      lastDoc = doc;
    }

    if (ops > 0) await batch.commit();

    if (snap.size < 1000) break;
  }
}

export const autoSignOutDaily = onSchedule("every 24 hours", async () => {
  await processCollection("students");
  await processCollection("tutors");
});
