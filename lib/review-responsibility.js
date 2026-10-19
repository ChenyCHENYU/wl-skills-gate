export function reviewApprovers(project) {
  return [
    ...new Set([
      ...(project.reviewers || []),
      ...(project.requireTechnicalManagerReview === true && project.technicalManager ? [project.technicalManager] : []),
    ]),
  ];
}
export function managerReviewSatisfied(project, { authorId, reviewerId, actorId }) {
  return (
    project.requireTechnicalManagerReview !== true ||
    (typeof project.technicalManager === "string" &&
      !!project.technicalManager &&
      ((actorId || reviewerId) === project.technicalManager || authorId === project.technicalManager))
  );
}
