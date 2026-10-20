ALTER TABLE occ.agents
  ADD COLUMN control_ui_bookmark_url text,
  ADD COLUMN control_ui_bookmark_version bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT agents_control_ui_bookmark_url_length CHECK (
    control_ui_bookmark_url IS NULL OR char_length(control_ui_bookmark_url) BETWEEN 1 AND 2048
  ),
  ADD CONSTRAINT agents_control_ui_bookmark_version CHECK (
    control_ui_bookmark_version BETWEEN 0 AND 9007199254740991
  );
--> statement-breakpoint
GRANT UPDATE (control_ui_bookmark_url, control_ui_bookmark_version) ON occ.agents TO occ_app;
