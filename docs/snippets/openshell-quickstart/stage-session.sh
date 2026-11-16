# Stage these files from the selected release checkout.
install -m 600 docs/snippets/openshell-quickstart/operator-session.sh "$RUN_DIR/operator-session.sh"
install -m 600 docs/snippets/openshell-quickstart/request.mts "$RUN_DIR/request.mts"
install -m 600 docs/snippets/openshell-quickstart/codex-configuration.jq "$RUN_DIR/codex-configuration.jq"
install -m 600 docs/snippets/openshell-quickstart/inspect-linear-transcript.mts "$RUN_DIR/inspect-linear-transcript.mts"
install -m 600 docs/assets/openshell-quickstart/chat.mjs "$RUN_DIR/chat.mjs"
install -m 600 docs/snippets/openshell-quickstart/kubernetes/git-revision-audit.mts "$RUN_DIR/git-revision-audit.mts"
