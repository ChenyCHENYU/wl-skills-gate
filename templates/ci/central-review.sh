#!/bin/sh
set -eu
# Configure once in the central automation job; values come from its protected
# configuration, never from a project's webhook payload or developer command.
: "${WL_GATE_PACKAGE:?fixed installed Gate package directory}"
: "${WL_REVIEW_CI_CONFIG:?fixed central review-ci configuration file}"
: "${WL_CI_SOURCE_FILE:?verified collect-ci source.json}"
: "${WL_REVIEW_EVIDENCE_OUT:?new directory within approved evidenceRoot}"
exec node "$WL_GATE_PACKAGE/bin/wl-skills-gate.js" review-ci \
  --config "$WL_REVIEW_CI_CONFIG" --source "$WL_CI_SOURCE_FILE" --out "$WL_REVIEW_EVIDENCE_OUT"
