# OSRS Update Impact Tracker

Automated tracker that monitors Old School RuneScape game updates and measures their price impact on the Grand Exchange. A GitHub Action runs every Thursday, fetches price data from before and after Wednesday's game update via the OSRS Wiki Prices API, calculates which items moved the most, and commits the results as JSON to this repo.
