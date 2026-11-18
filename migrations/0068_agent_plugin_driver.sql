ALTER TABLE occ.agents ADD COLUMN plugin_driver jsonb,
  ADD CONSTRAINT agents_plugin_driver_selection CHECK (
    CASE WHEN coalesce(plugins, '{}'::jsonb) = '{}'::jsonb THEN plugin_driver IS NULL
    ELSE plugin_driver IS NOT NULL
      AND jsonb_typeof(plugin_driver) = 'object'
      AND plugin_driver ?& ARRAY['id', 'implementation']
      AND (plugin_driver - 'id' - 'implementation') = '{}'::jsonb
      AND jsonb_typeof(plugin_driver->'id') = 'string'
      AND jsonb_typeof(plugin_driver->'implementation') = 'string'
      AND (plugin_driver->>'id') ~ '[^[:space:]]'
      AND (plugin_driver->>'implementation') ~ '[^[:space:]]'
    END
  );
--> statement-breakpoint
GRANT UPDATE (plugin_driver) ON occ.agents TO occ_app;
