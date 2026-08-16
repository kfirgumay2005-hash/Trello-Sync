# Trello Sync for Obsidian

Live bidirectional sync between Trello boards and your Obsidian notes.

## Installation

1. Install and enable the plugin from Obsidian Community Plugins
2. Sign into Trello and create an app here: https://trello.com/apps/admin
3. Copy the API key into the plugin
4. Click the token link near the API key on the Trello website and copy it into the API Token field of the plugin.
5. if the plugin not refresh the new keys simply disable and enable the plugin to refresh it.

## Setup:

Add a Mapping and select the board you wish to sync and the note you wish to sync it into.

Set the auto-sync interval.

## Features!

1. Create new card: Press the button "Create Trello Card" with the + icon on the sidebar menu, or simply Add a checkbox to a list in the note you provided to add a new card to the board . Don't remove the Id near each card.
   Currently support Card name , Label/Tag , Start and Due Dates
   (Highly recommend to add Dates and Tags from Trello or the sidebar menu rather than manually when creating a card)

2. Deletion Behavior: Select what happens when you remove a card from obsidian: Archive in Trello or delete it permanently.

3. Checkbox Automation: Enable to automatically transfer cards you checked to a different list.

4. Tag Automation: Sync all Obsidian notes with a specific tag into a list.
   Example: Every note with #inactive tag can be transfered into "inactive" list in Trello.

5. Automatic add Subfolders and Notes within an obsidian folder to a list: If you have a Projects folder for example then everytime you move notes and folders from or into it , the plugin will update it in a trello list you choose
