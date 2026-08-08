import { App, PluginSettingTab, Setting, TFolder } from 'obsidian';
import TrelloSyncPlugin, { TrelloBoard } from './main';

export interface BoardMapping {
	boardId: string;
	targetNotePath: string;
}

export interface TrelloPluginSettings {
	apiKey: string;
	apiToken: string;
	syncIntervalSeconds: number;
	deleteBehavior: 'delete' | 'archive';
	boardMappings: BoardMapping[];

	// Folder to Trello List Settings
	enableFolderToTrello: boolean;
	folderToTrelloSourceFolder: string;
	folderToTrelloBoardId: string;
	folderToTrelloListId: string;
}

export const DEFAULT_SETTINGS: TrelloPluginSettings = {
	apiKey: '',
	apiToken: '',
	syncIntervalSeconds: 30,
	deleteBehavior: 'archive',
	boardMappings: [],

	enableFolderToTrello: false,
	folderToTrelloSourceFolder: '',
	folderToTrelloBoardId: '',
	folderToTrelloListId: '',
};

export class TrelloSyncSettingTab extends PluginSettingTab {
	plugin: TrelloSyncPlugin;

	constructor(app: App, plugin: TrelloSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions() {
		return [];
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// --- Trello Connection ---
		new Setting(containerEl).setName('Trello Connection').setHeading();

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

		// --- Board & Note Mappings ---
		new Setting(containerEl).setName('Board & Note Mappings').setHeading();

		const currentMappingsCount = this.plugin.settings.boardMappings.length;

		new Setting(containerEl)
			.setName('Add Board Mapping')
			.setDesc(
				`Map up to 10 Trello boards to Obsidian notes (Current: ${currentMappingsCount}/10)`,
			)
			.addButton((button) => {
				button
					.setButtonText('+ Add New Mapping')
					.setCta()
					.onClick(async () => {
						if (this.plugin.settings.boardMappings.length < 10) {
							this.plugin.settings.boardMappings.push({
								boardId: '',
								targetNotePath: '',
							});
							await this.plugin.saveSettings();
							this.display();
						}
					});

				button.buttonEl.disabled = currentMappingsCount >= 10;
			});

		if (!this.plugin.settings.apiKey || !this.plugin.settings.apiToken) {
			new Setting(containerEl).setDesc(
				'⚠️ Please enter a valid API Key and Token to configure mappings.',
			);
			return;
		}

		void Promise.all([
			this.plugin.getTrelloBoards().catch(() => [] as TrelloBoard[]),
			Promise.resolve(this.app.vault.getMarkdownFiles()),
		]).then(([boards, markdownFiles]) => {
			this.plugin.settings.boardMappings.forEach((mapping, index) => {
				const setting = new Setting(containerEl).setName(
					`Mapping #${index + 1}`,
				);

				// Dropdown 1: Trello Board
				setting.addDropdown((dropdown) => {
					dropdown.addOption('', '-- Select Board --');
					boards.forEach((board) => {
						dropdown.addOption(board.id, board.name);
					});
					dropdown.setValue(mapping.boardId);
					dropdown.onChange(async (value) => {
						mapping.boardId = value;
						await this.plugin.saveSettings();
					});
				});

				// Dropdown 2: Target Note
				setting.addDropdown((dropdown) => {
					dropdown.addOption('', '+ Create new note');
					markdownFiles.forEach((file) => {
						dropdown.addOption(file.path, file.basename);
					});
					dropdown.setValue(mapping.targetNotePath);
					dropdown.onChange(async (value) => {
						mapping.targetNotePath = value;
						await this.plugin.saveSettings();
					});
				});

				// Delete Button
				setting.addButton((button) => {
					button.setIcon('trash').onClick(async () => {
						this.plugin.settings.boardMappings.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					});

					button.buttonEl.addClass('mod-warning');
					button.buttonEl.setAttribute(
						'aria-label',
						'Remove this mapping',
					);
				});
			});

			// --- Folder to Trello List Section ---
			new Setting(containerEl)
				.setName('Auto-Add Folder Items names to a Trello List')
				.setHeading();

			new Setting(containerEl)
				.setName('Sync all Subfolders and Notes names to a list ')
				.setDesc(
					'If you have a Projects folder then everytime you move notes and folders from or into it , the plugin will update it in a trello list you choose ',
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.enableFolderToTrello)
						.onChange(async (value) => {
							this.plugin.settings.enableFolderToTrello = value;
							await this.plugin.saveSettings();
							this.display();
						}),
				);

			if (this.plugin.settings.enableFolderToTrello) {
				const allFolders = this.app.vault
					.getAllLoadedFiles()
					.filter((f): f is TFolder => f instanceof TFolder);

				new Setting(containerEl)
					.setName('Source Obsidian Folder')
					.setDesc(
						'Select the folder whose contents will be added to Trello',
					)
					.addDropdown((dropdown) => {
						dropdown.addOption('', '-- Select Folder --');
						allFolders.forEach((folder) => {
							dropdown.addOption(
								folder.path,
								folder.path === '/'
									? 'Vault Root (/)'
									: folder.path,
							);
						});
						dropdown.setValue(
							this.plugin.settings.folderToTrelloSourceFolder,
						);
						dropdown.onChange(async (value) => {
							this.plugin.settings.folderToTrelloSourceFolder =
								value;
							await this.plugin.saveSettings();
						});
					});

				const selectedBoardId =
					this.plugin.settings.folderToTrelloBoardId;

				new Setting(containerEl)
					.setName('Target Trello Board')
					.setDesc('Select the Trello board')
					.addDropdown((dropdown) => {
						dropdown.addOption('', '-- Select Board --');
						boards.forEach((board) => {
							dropdown.addOption(board.id, board.name);
						});
						dropdown.setValue(selectedBoardId);
						dropdown.onChange(async (value) => {
							this.plugin.settings.folderToTrelloBoardId = value;
							this.plugin.settings.folderToTrelloListId = ''; // Reset list selection when board changes
							await this.plugin.saveSettings();
							this.display();
						});
					});

				if (selectedBoardId) {
					void this.plugin
						.getBoardLists(selectedBoardId)
						.then((lists) => {
							new Setting(containerEl)
								.setName('Target Trello List (Column)')
								.setDesc(
									'Select the list/column where new cards will be created',
								)
								.addDropdown((dropdown) => {
									dropdown.addOption('', '-- Select List --');
									lists.forEach((list) => {
										dropdown.addOption(list.id, list.name);
									});
									dropdown.setValue(
										this.plugin.settings
											.folderToTrelloListId,
									);
									dropdown.onChange(async (value) => {
										this.plugin.settings.folderToTrelloListId =
											value;
										await this.plugin.saveSettings();
									});
								});
						});
				}
			}
		});

		// --- Preferences & Sync Interval ---
		new Setting(containerEl).setName('Sync Preferences').setHeading();

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
