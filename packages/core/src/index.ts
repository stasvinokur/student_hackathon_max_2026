// Functional core: pure, deterministic domain logic only.
// No I/O, no clock, no randomness — everything comes in as arguments.

export const CORE_VERSION = '0.1.0';

export type { ButtonSpec, ReplySpec } from './bot/reply.js';
export { stepReply } from './bot/step-reply.js';
export { keepOpeningPayload, parseRoutePayload, rescheduleOpeningPayload, type RoutePayload } from './bot/payloads.js';
export { keepOpeningReplies, rescheduleOfferReply, rescheduleReplies, type KeepOutcome, type RescheduleOutcome } from './bot/opening.js';

export { PREDICATE_FIELDS, isPredicateField, type Profile, type PredicateField } from './profile.js';
export {
  ActionCardSchema,
  KEBAB_ID,
  KINDS,
  LANES,
  PackManifestSchema,
  PlaceSchema,
  PredicateSchema,
  RulesPackSchema,
  type ActionCard,
  type BBox,
  type Kind,
  type Lane,
  type PackManifest,
  type Place,
  type Predicate,
  type RulesPack,
} from './rules/schema.js';
export { evaluatePredicate } from './rules/predicate.js';
export { findCycle, parseRulesPack, type PackIssue, type ParsePackResult } from './rules/validate.js';
export { addDays, diffDays, formatDate, formatDayMonth, formatDayMonthNear, formatDueDate, isIsoDate } from './rules/dates.js';
export { plural } from './rules/plural.js';
export {
  buildRoute,
  nextBestStep,
  readiness,
  stepsUnblockedBy,
  topBlockers,
  type BuildRouteResult,
  type ClarificationReason,
  type Readiness,
  type Route,
  type RouteStep,
  type TaskStatus,
  type TaskStatuses,
} from './rules/route.js';
export {
  decideKeep,
  decideReschedule,
  lateOpeningText,
  openingDelayDays,
  type KeepDecision,
  type OpeningMove,
  type RescheduleDecision,
} from './rules/opening.js';
export {
  initialOnboardingState,
  ONBOARDING_STEPS,
  parseDate,
  transition,
  type OnboardingContext,
  type OnboardingInput,
  type OnboardingResult,
  type OnboardingState,
  type OnboardingStep,
  type Region,
} from './onboarding/machine.js';
export {
  verifyInitData,
  type HmacSha256,
  type InitDataFailure,
  type InitDataUser,
  type VerifyInitDataOptions,
  type VerifyInitDataResult,
} from './auth/init-data.js';
export {
  PlaceViewSchema,
  ReadinessSchema,
  RoutePlaceSchema,
  RouteViewSchema,
  TaskDetailSchema,
  TaskRefSchema,
  TaskSummarySchema,
  toRouteView,
  toTaskDetail,
  toTaskSummary,
  type PlaceView,
  type RoutePlace,
  type RouteView,
  type TaskDetail,
  type TaskSummary,
} from './rules/view.js';
export { DEADLINE_LEAD_DAYS, planReminders, reminderReply, type ReminderKind, type ReminderPlan } from './reminders/plan.js';
export { shareText } from './rules/share.js';
export { explainPrompt, sanitizeExplanation, type ChatMessage } from './llm/explain.js';

// Location index: the «Карта» tab (doc-3). Only what the shell needs: the runtime for the mini-app and the
// API, the offline builder for the CLI of apps/api (the mini-app bundle drops it: "sideEffects": false).
// Test data: '@otkryvay/core/testing'.
export {
  IMPORTANCE,
  IMPORTANCE_WEIGHT,
  LocationCriteriaSchema,
  LocationCriterionConfigSchema,
  LocationCriterionSchema,
  LocationIndexSchema,
  LocationPlaceSchema,
  type FactColumn,
  type Importance,
  type LocationCriteria,
  type LocationCriterion,
  type LocationCriterionConfig,
  type LocationFact,
  type LocationIndex,
  type LocationPlace,
  type SaturationCriterion,
} from './location/schema.js';
export { parseLocationCriteria, parseLocationIndex, type ParseLocationResult } from './location/parse.js';
export { cellAt, cellCenter, cellRing, formatDistance, formatInt, formatRadius, gridFor, type LatLon, type LocationGrid } from './location/geo.js';
export {
  scoreLocations,
  type Competition,
  type LocationSettings,
  type ScoreOptions,
  type ScoreResult,
  type ScoreWarning,
  type TopPlace,
} from './location/score.js';
export {
  criterionReach,
  describeCriterion,
  explainCell,
  importanceLabel,
  indexAttribution,
  placeTitle,
  type CellExplanation,
  type CellFactor,
  type CompetitionVerdict,
} from './location/explain.js';
export {
  buildingCentres,
  buildingsCountQuery,
  buildingsQuery,
  featuresFromOverpass,
  isOsmTime,
  overpassCountQuery,
  overpassOsmBase,
  overpassQuery,
  type OsmFeature,
  type OverpassQueryOptions,
} from './location/osm.js';
export { buildLocationIndex, type BuildLocationIndexInput } from './location/build.js';
