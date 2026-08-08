// ============================================================================
// FAQ content, shared by the rendered page and its FAQPage JSON-LD.
//
// One source for both on purpose: Google treats a rich-result payload that
// disagrees with the visible page as a structured-data violation, and the
// usual way that happens is someone edits the copy and forgets the schema
// blob. Here it cannot drift — the same array renders both.
//
// The questions are written as the SEARCHES, not as tidy headings. The target
// is the long-tail conversational query ("what app is best for turnovers in
// low service areas") and the "People also ask" block, so the question text
// deliberately reads like something a person typed.
//
// Every answer must be true per ./offline-capabilities.ts. Answer 5 exists to
// say what does NOT work — a page that only claims wins reads like every other
// vendor's page, and the honest limits are what a skeptical PM is looking for.
// ============================================================================

export interface FaqItem {
  question: string
  answer:   string
}

export const FAQS: FaqItem[] = [
  {
    question: 'What app is best for turnovers in low service areas?',
    answer:
      'FieldStay is built offline-first for exactly this. The crew app installs to the phone and stores ' +
      'the day\'s turnovers, checklists, property details and inventory on the device, so it opens and ' +
      'works with no bars at all. Cleaners tick items, take photos and complete turnovers normally; ' +
      'everything queues locally and uploads the moment the phone finds signal again — usually before ' +
      'they have driven back to the main road.',
  },
  {
    question: 'Does the cleaning checklist work without internet?',
    answer:
      'Yes. The entire checklist — every room and item, including photo requirements — is cached on the ' +
      'phone before the crew arrives. Ticking items, adding notes and attaching photos all work with the ' +
      'phone in airplane mode. Completion timestamps are recorded on the device at the moment of the tap, ' +
      'not when it syncs, so job duration stays accurate even if the upload happens an hour later.',
  },
  {
    question: 'What happens to photos taken with no cell service?',
    answer:
      'They are stored on the device in their own upload queue and sent independently of everything else, ' +
      'with automatic retries. A 40-photo turnover in a basement is not held up by one failed request, ' +
      'and a photo that ultimately cannot upload shows in the app with a retry button rather than ' +
      'disappearing.',
  },
  {
    question: 'Will I lose work if the phone dies or the app closes mid-turnover?',
    answer:
      'No. Each change and its pending upload are written to the phone in a single transaction, so a ' +
      'phone killed mid-tap either has the change and the queued upload or neither — never a checkbox ' +
      'that looks ticked but was never queued. Reopening the app picks up exactly where the crew left off.',
  },
  {
    question: 'What does NOT work offline in FieldStay?',
    answer:
      'Three things need a connection: requesting time off, scrolling back through message history ' +
      '(sending a message queues offline fine), and the manager dashboard, which assumes a desk. Offline ' +
      'support is built for the crew app on a phone at the property.',
  },
  {
    question: 'Do cleaners need to remember to sync?',
    answer:
      'No. There is no sync button to forget. The app uploads in the background whenever it has a ' +
      'connection, replaying changes in the order they were made. The only time a crew member sees ' +
      'anything about syncing is if something genuinely failed, which surfaces with a retry button.',
  },
  {
    question: 'Does this work for rural or mountain vacation rentals?',
    answer:
      'That is the case it was designed around. Cabins, lake houses and mountain properties routinely ' +
      'have no usable signal inside the building even when the driveway has a bar. Because FieldStay ' +
      'caches everything the crew needs before they arrive and queues everything they do, the crew never ' +
      'has to stand outside to load a checklist or upload a photo.',
  },
  {
    question: 'Is FieldStay offline-first or just offline-tolerant?',
    answer:
      'Offline-first. The crew app reads from local device storage as its normal mode of operation and ' +
      'syncs in the background — it is not an online app with a cache bolted on. There is no separate ' +
      '"offline mode" to switch into, because there is no online mode to switch out of.',
  },
]
