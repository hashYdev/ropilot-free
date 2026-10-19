// @ts-check
// Credit reimbursement notices — free build.
//
// The shipped version watched the managed-credits balance response for a
// `reimbursement` payload and popped a modal telling the user Ropilot had
// returned credits after a billing problem, keyed by campaign id
// (cache-loss-20260918, opus55-billing-20260923, support-refunds-20260928, ...)
// and remembered per id in localStorage so it only ever showed once.
//
// All of that is about a balance and an account this build does not have. The
// exports are kept with the same signatures so settings.js does not have to
// care.

/** Nothing is ever a valid reimbursement notice in this build. */
export function validNotice(value) {
  return false;
}

export function showCreditReimbursement() {
  return;
}
