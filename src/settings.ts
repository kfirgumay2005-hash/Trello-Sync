import { App, PluginSettingTab, Setting } from 'obsidian';
import TrelloSyncPlugin from './main';

export interface TrelloPluginSettings {
	apiKey: string;
	apiToken: string;
	selectedBoardId: string;
	syncIntervalSeconds: number;
	targetNotePath: string;
	deleteBehavior: 'delete' | 'archive';
}

export const DEFAULT_SETTINGS: TrelloPluginSettings = {
	apiKey: '',
	apiToken: '',
	selectedBoardId: '',
	syncIntervalSeconds: 30,
	targetNotePath: '',
	deleteBehavior: 'archive',
};

export class TrelloSyncSettingTab extends PluginSettingTab {
	plugin: TrelloSyncPlugin;

	constructor(app: App, plugin: TrelloSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// Proper Obsidian Heading API
		new Setting(containerEl)
			.setName('Trello Connection Settings')
			.setHeading();

		// API Key Setting
		new Setting(containerEl)
			.setName('Trello API Key')
			.setDesc('Enter your Trello API Key')
			.addText((text) =>
				text
					.setPlaceholder('Enter API Key...')
					.setValue(this.plugin.settings.apiKey)
					.onChange((value) => {
						this.plugin.settings.apiKey = value.trim();
						void this.plugin.saveSettings().then(() => {
							this.plugin.setupSyncInterval();
							if (
								this.plugin.settings.apiKey &&
								this.plugin.settings.apiToken
							) {
								this.display();
							}
						});
					}),
			);

		// API Token Setting
		new Setting(containerEl)
			.setName('Trello API Token')
			.setDesc('Enter your Trello API Token')
			.addText((text) =>
				text
					.setPlaceholder('Enter Token...')
					.setValue(this.plugin.settings.apiToken)
					.onChange((value) => {
						this.plugin.settings.apiToken = value.trim();
						void this.plugin.saveSettings().then(() => {
							this.plugin.setupSyncInterval();
							if (
								this.plugin.settings.apiKey &&
								this.plugin.settings.apiToken
							) {
								this.display();
							}
						});
					}),
			);

		// Section Heading
		new Setting(containerEl).setName('Board & Sync Settings').setHeading();

		// Board Selection Dropdown
		const boardSetting = new Setting(containerEl)
			.setName('Select Trello Board')
			.setDesc('Select the board you want to sync with Obsidian');

		if (!this.plugin.settings.apiKey || !this.plugin.settings.apiToken) {
			boardSetting.setDesc(
				'⚠️ Please enter a valid API Key and Token to load boards.',
			);
			return;
		}

		void this.plugin
			.getTrelloBoards()
			.then((boards) => {
				if (!boards || boards.length === 0) {
					boardSetting.setDesc(
						'No boards found in your Trello account.',
					);
					return;
				}

				boardSetting.addDropdown((dropdown) => {
					dropdown.addOption('', '-- Select a Board --');

					boards.forEach((board) => {
						dropdown.addOption(board.id, board.name);
					});

					dropdown.setValue(this.plugin.settings.selectedBoardId);

					dropdown.onChange((value) => {
						this.plugin.settings.selectedBoardId = value;
						void this.plugin.saveSettings().then(() => {
							void this.plugin.syncSelectedBoard(true);
						});
					});
				});
			})
			.catch((error: unknown) => {
				console.error('Failed to load boards in settings:', error);
				boardSetting.setDesc(
					'❌ Error loading boards. Please verify your API credentials.',
				);
			});

		// Target Note Selection Dropdown
		const noteSetting = new Setting(containerEl)
			.setName('Select Target Note')
			.setDesc(
				'Choose an existing note to sync with, or select Create New Note',
			);

		const markdownFiles = this.app.vault.getMarkdownFiles();

		noteSetting.addDropdown((dropdown) => {
			dropdown.addOption('', '+ Create new note (Trello sync)');

			markdownFiles.forEach((file) => {
				dropdown.addOption(file.path, file.basename);
			});

			dropdown.setValue(this.plugin.settings.targetNotePath || '');

			dropdown.onChange((value) => {
				this.plugin.settings.targetNotePath = value;
				void this.plugin.saveSettings();
				this.plugin.knownCardIds.clear();
			});
		});

		// Deletion Behavior Dropdown
		new Setting(containerEl)
			.setName('Deletion Behavior')
			.setDesc(
				'Choose what happens in Trello when a card is deleted from Obsidian',
			)
			.addDropdown((dropdown) => {
				dropdown.addOption('archive', 'Archive (Close) Card in Trello');
				dropdown.addOption(
					'delete',
					'Permanently Delete Card in Trello',
				);

				dropdown.setValue(
					this.plugin.settings.deleteBehavior || 'archive',
				);

				dropdown.onChange((value) => {
					this.plugin.settings.deleteBehavior = value as
						| 'delete'
						| 'archive';
					void this.plugin.saveSettings();
				});
			});

		// Sync Interval Setting
		new Setting(containerEl)
			.setName('Auto-Sync Interval (Seconds)')
			.setDesc(
				'Set how often (in seconds) Obsidian should sync with Trello',
			)
			.addText((text) =>
				text
					.setPlaceholder('30')
					.setValue(
						String(this.plugin.settings.syncIntervalSeconds || 30),
					)
					.onChange((value) => {
						const num = parseInt(value.trim(), 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.syncIntervalSeconds = num;
							void this.plugin.saveSettings().then(() => {
								this.plugin.setupSyncInterval();
							});
						}
					}),
			);
	}
}
