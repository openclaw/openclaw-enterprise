# Stage these files before switching to the release checkout.
install -m 600 docs/snippets/openshell-quickstart/operator-session.sh "$RUN_DIR/operator-session.sh"
install -m 600 docs/snippets/openshell-quickstart/request.mjs "$RUN_DIR/request.mjs"
install -m 600 docs/snippets/openshell-quickstart/codex-configuration.jq "$RUN_DIR/codex-configuration.jq"
install -m 600 docs/snippets/openshell-quickstart/inspect-linear-transcript.mjs "$RUN_DIR/inspect-linear-transcript.mjs"
install -m 600 docs/assets/openshell-quickstart/chat.mjs "$RUN_DIR/chat.mjs"
install -m 600 docs/snippets/openshell-quickstart/kubernetes/git-revision-audit.mjs "$RUN_DIR/git-revision-audit.mjs"
