# In-play HUD

`ui/gameHud.ts` owns the two approved cardless corner overlays. It stays hidden
behind the entry ticket and never owns input.

- Bottom-right movement reminders reuse the serif contextual-prompt language.
  An on-foot guest gets walk/brisk hints above water and adds the underwater
  push-off below water. Borrowed player control suppresses hints for every ride;
  the submarine's explicit `isAboard` state substitutes its pilot/dive/rise set.
  Teleport freezes and the pause card also suppress the reminders.
- Top-right FPS uses the game loop's real presentation interval, not update CPU
  time. A 350 ms exponential filter and 400 ms text cadence keep the number
  legible without making it visually restless.
- Both overlays are text-only with no panel or background. Existing contextual
  E prompts remain independent and retain center-screen priority.
