# wordle-autosolver
A small userscript that solves Wordle for you. Shows the best next guess, and can auto-solve on [NYT Wordle](https://www.nytimes.com/games/wordle/) and [Wordle Unlimited](https://wordleunlimited.org/).
## Features

- Shows the best next guess in a small floating panel
- Tells you how many answers are still possible
- Auto-solve, which types and submits guesses for you
- "Stay on after solving" switch, so auto-solve keeps going between games and after reloads
- One-click submit if you'd rather do it manually

## Install

1. Get [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Install the script from [Greasy Fork](https://greasyfork.org/scripts/YOUR_SCRIPT_ID) or the [raw file on GitHub](https://github.com/YOUR_USERNAME/wordle-autosolver/raw/main/wordle-solver.user.js).
3. Open a Wordle page and click the button in the bottom-right corner.

## Use

Open the panel to see the suggested word and how many answers are left. Hit **Submit best guess** to enter it, or turn on **Auto-solve**. The button glows gold while auto-solve is running.

With **Stay on after solving** enabled, auto-solve survives new games and reloads. With it off, closing the panel stops auto-solve.

## How it works

After each guess, the script drops every word that couldn't have given that feedback, then picks the remaining word with the most common letters. The word list comes from [seanpatlan/wordle-words](https://github.com/seanpatlan/wordle-words) and is cached for a week. That's the only thing it downloads, and nothing leaves your browser.
