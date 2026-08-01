/**
 * The review: Verification's second stage, for an instance that asked for one. A
 * short Run of its own reads what an Attempt left behind and says whether it
 * meets the ticket. It judges nothing the project's own commands have already
 * refused — there is nothing to review about work that does not build, and
 * asking would spend quota to be told what is already known.
 */
export type ReviewVerdict = "approved" | "rejected";

/** What the review made of an Attempt, kept with the Attempt itself. */
export interface AttemptReview {
  verdict: ReviewVerdict;
  /**
   * The reviewer's own account of the verdict. A rejection's is what refuses the
   * Attempt and what the next one is told, so it is worth a sentence somebody
   * could act on rather than a word.
   */
  reasoning: string;
}

/**
 * The whole of what a review answered. The criteria are not kept with the
 * Attempt the way the verdict is: their home is the ticket itself, where a
 * criterion the review found met comes back ticked for the morning to read.
 */
export interface ReviewAnswer extends AttemptReview {
  /**
   * The ticket's own acceptance criteria the review judged met, in its own copy
   * of their words. A criterion it said nothing about is one nothing judged.
   */
  criteriaMet: string[];
}

/** Whether this instance puts a verified Attempt in front of a reviewer at all. */
export interface ReviewSettings {
  /**
   * Off unless an instance asks for it. A review is another Run against the same
   * subscription, and a Supervisor that spends quota nobody asked it to spend is
   * one that runs out of night early.
   */
  enabled: boolean;
}
