# LiqueDT - NASDAQ market context

LiqueDT NASDAQ is a live, Singapore-time companion for the Nasdaq 100: market windows, related cross-market drivers, high-impact USD events, and Nasdaq-sensitive headlines. It contains no trading or execution features.

## Windows app

Open `dist\LiqueDT-NASDAQ.exe`. It launches LiqueDT in a dedicated desktop window with its own local data gateway. Keep the adjacent `app` folder beside the executable.

To share it, send the latest ZIP in `release\v1.0.6\`. The recipient must extract the whole ZIP into a new folder before running `LiqueDT-NASDAQ.exe`.

## iPhone / GitHub Pages app

Upload the contents of `GitHub-Pages-Upload` to a GitHub repository and enable GitHub Pages. Open the HTTPS URL in Safari on iPhone, tap Share, then Add to Home Screen.

GitHub Pages cannot run the local desktop gateway, so the workflow builds public static snapshots. The app labels snapshots with the generated/checked time.

## Included

- Singapore clock and U.S. cash-session NASDAQ open/closed countdown.
- DST-aware Asia, London, and New York liquidity windows.
- Interactive charts for NDX, SPX, U.S. 10Y yield, VIX, and SOXX.
- Correlation-aware cross-market read for Nasdaq context.
- Upcoming medium/high-impact USD economic events.
- Nasdaq-sensitive headlines with estimated bullish/bearish/balanced narrative impact.
- Installable PWA shell and direct FormSubmit feedback to LiqueDT@gmail.com.

## Verification

```powershell
python .\verify_app.py
```

LiqueDT is informational context, not financial advice or a signal service.
