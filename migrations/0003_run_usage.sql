-- Token usage per Run, so provider spend can be attributed rather than guessed.
-- Reasoning tokens bill at the output rate and are the suspected bulk of ChatGPT
-- cost, but they are invisible without recording them: output_tokens already
-- includes them, so the split is what makes the bill legible.
ALTER TABLE runs ADD COLUMN input_tokens INTEGER;
ALTER TABLE runs ADD COLUMN output_tokens INTEGER;
ALTER TABLE runs ADD COLUMN reasoning_tokens INTEGER;
ALTER TABLE runs ADD COLUMN cached_input_tokens INTEGER;
-- Wall-clock for the provider call. The 120s timeout cut off a third of ChatGPT
-- Prompts with no record of how close the survivors came to it.
ALTER TABLE runs ADD COLUMN duration_ms INTEGER;
