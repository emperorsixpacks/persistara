# Mission workspace design

The owner requested a substantial UI improvement using Tender as a quality reference, with different colors. Tender's local application source was inspected for shell/navigation, task-card hierarchy, page headings and task/detail composition. No Tender source, imagery, brand assets or font files were imported. Persistara's markup, CSS, inline icons and document/continuity illustration are independently implemented.

The palette is graphite (`#12191f`), slate panels (`#192229`), cool neutral text (`#e9eef1`) and copper (`#e7a881`). A warm featured card identifies a dossier awaiting owner review; semantic status labels remain legible without depending on color. System sans typography replaces the earlier serif landing layout. A persistent sidebar, compact top bar and mission-first content hierarchy replace the previous onboarding page.

Implemented views: mission desk with filters/search and actual counts, immutable brief form, mission detail with source excerpts and artifact review, timeline/activity, owner controls and evidence. Empty states contain original code-native artwork and instructions; production does not seed fictional missions or silently use test transports.

Responsive checks cover desktop cards/detail and a 390-pixel phone layout without horizontal overflow. Mobile navigation makes the underlying workspace inert, traps keyboard focus, closes on Escape and returns focus to the menu button. Forms/review dialogs use native modal behavior, labels, acknowledgement controls and disabled in-flight actions. Dynamic source/brief content is escaped; scripts/HTML in a title remain literal text. Reduced motion, visible focus and private session invalidation are preserved.

These screenshots are **explicit browser fixtures**, not live-wallet or source-verification evidence:

![Desktop mission desk](images/mission-desk-desktop.png)

![Mission dossier and execution timeline](images/mission-detail-desktop.png)

![Phone mission desk](images/mission-desk-mobile.png)

The source fixture banner remains visible. The original owner CLI login and real public-source mission are documented separately in `docs/evidence`. The model-driven research product, public hosting and live browser-wallet approval remain pending.


The commission detail adds a four-stage quote/reservation/delivery/settlement timeline, explicit price and upload-cost review, signed-file exchange, inspectable receipts and decrypted source preview. Pending callback states remain distinct from paid. Quote review exposes delivery/review deadlines and buyer-controlled dispute terms before approval. The following captures are also disposable browser fixtures:

![Exact quote and cost review](images/commerce-quote-review.png)

![Encrypted specialist delivery ready for review](images/commerce-delivery-desktop.png)

![Paid and reviewed mission on a phone](images/commerce-settled-mobile.png)
