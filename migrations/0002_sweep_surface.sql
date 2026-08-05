-- A sweep is now one cron firing: every active Prompt against ONE Surface.
--
-- Collecting all three Surfaces in a single firing did not fit: Cron Triggers
-- stop at 15 minutes of wall clock, and the 2026-07-30 sweep was cut off there
-- with Gemini never started. Per-Surface schedules give each its own budget.
--
-- Sweeps recorded before the split covered every Surface, so their surface is
-- NULL rather than wrong.
ALTER TABLE sweeps ADD COLUMN surface TEXT;
