import { App, PluginSettingTab, Setting, TFolder } from 'obsidian';
import TrelloSyncPlugin, { TrelloBoard, TrelloList } from './main';

export interface ListAutomation {
	sourceListId: string;
	targetListId: string;
}

export interface BoardMapping {
	boardId: string;
	targetNotePath: string;
	enableMoveOnCheck?: boolean;
	automations?: ListAutomation[];
	moveSourceListId?: string;
	moveTargetListId?: string;
}

export interface TagAutomation {
	tag: string;
	boardId: string;
	listId: string;
}

export interface TrelloPluginSettings {
	apiKey: string;
	apiToken: string;
	syncIntervalSeconds: number;
	deleteBehavior: 'delete' | 'archive';
	boardMappings: BoardMapping[];

	enableFolderToTrello: boolean;
	folderToTrelloSourceFolder: string;
	folderToTrelloBoardId: string;
	folderToTrelloListId: string;

	tagAutomations: TagAutomation[];
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

	tagAutomations: [],
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
								automations: [],
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
		]).then(async ([boards, markdownFiles]) => {
			const listsByBoard = new Map<string, TrelloList[]>();

			for (const mapping of this.plugin.settings.boardMappings) {
				if (mapping.boardId && !listsByBoard.has(mapping.boardId)) {
					const lists = await this.plugin
						.getBoardLists(mapping.boardId)
						.catch(() => []);
					listsByBoard.set(mapping.boardId, lists);
				}
			}

			if (this.plugin.settings.tagAutomations) {
				for (const auto of this.plugin.settings.tagAutomations) {
					if (auto.boardId && !listsByBoard.has(auto.boardId)) {
						const lists = await this.plugin
							.getBoardLists(auto.boardId)
							.catch(() => []);
						listsByBoard.set(auto.boardId, lists);
					}
				}
			}

			this.plugin.settings.boardMappings.forEach((mapping, index) => {
				const setting = new Setting(containerEl).setName(
					`Mapping #${index + 1}`,
				);

				setting.addDropdown((dropdown) => {
					dropdown.addOption('', '-- Select Board --');
					boards.forEach((board) => {
						dropdown.addOption(board.id, board.name);
					});
					dropdown.setValue(mapping.boardId);
					dropdown.onChange(async (value) => {
						mapping.boardId = value;
						await this.plugin.saveSettings();
						this.display();
					});
				});

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

				const automationSetting = new Setting(containerEl)
					.setName(`Checkbox Automation (Mapping #${index + 1})`)
					.setDesc(
						'Move card to another column when checked / unchecked',
					);

				automationSetting.addToggle((toggle) => {
					toggle
						.setValue(mapping.enableMoveOnCheck || false)
						.onChange(async (value) => {
							mapping.enableMoveOnCheck = value;
							if (value && !mapping.automations) {
								mapping.automations = [];
							}
							await this.plugin.saveSettings();
							this.display();
						});
				});

				if (mapping.enableMoveOnCheck && mapping.boardId) {
					const lists = listsByBoard.get(mapping.boardId) || [];

					mapping.automations?.forEach((automation, autoIndex) => {
						const ruleSetting = new Setting(containerEl)
							.setName(`Rule #${autoIndex + 1}`)
							.addDropdown((dropdown) => {
								dropdown.addOption('', '-- Source List --');
								lists.forEach((list) =>
									dropdown.addOption(list.id, list.name),
								);
								dropdown.setValue(
									automation.sourceListId || '',
								);
								dropdown.onChange(async (value) => {
									automation.sourceListId = value;
									await this.plugin.saveSettings();
								});
							})
							.addDropdown((dropdown) => {
								dropdown.addOption(
									'',
									'-- Target List (Done) --',
								);
								lists.forEach((list) =>
									dropdown.addOption(list.id, list.name),
								);
								dropdown.setValue(
									automation.targetListId || '',
								);
								dropdown.onChange(async (value) => {
									automation.targetListId = value;
									await this.plugin.saveSettings();
								});
							})
							.addButton((button) => {
								button.setIcon('x-circle').onClick(async () => {
									mapping.automations!.splice(autoIndex, 1);
									await this.plugin.saveSettings();
									this.display();
								});
								button.buttonEl.setAttribute(
									'aria-label',
									'Remove Rule',
								);
							});

						ruleSetting.settingEl.style.borderTop = 'none';
						ruleSetting.settingEl.style.paddingTop = '0';
					});

					const addRuleSetting = new Setting(containerEl);
					addRuleSetting.settingEl.style.borderTop = 'none';
					addRuleSetting.addButton((button) => {
						button
							.setButtonText('+ Add Automation Rule')
							.onClick(async () => {
								if (!mapping.automations)
									mapping.automations = [];
								mapping.automations.push({
									sourceListId: '',
									targetListId: '',
								});
								await this.plugin.saveSettings();
								this.display();
							});
					});
				}
			});

			// --- Tag Automations ---
			new Setting(containerEl)
				.setName('Auto-Add Tagged Notes to Trello')
				.setHeading();

			// Bypass TS missing method with (as any)
			const allObsidianTags = Object.keys(
				(this.app.metadataCache as any).getTags?.() || {},
			);

			new Setting(containerEl)
				.setName('Add Tag Automation')
				.setDesc(
					'Create Trello cards automatically for notes with a specific tag.',
				)
				.addButton((button) => {
					button
						.setButtonText('+ Add Tag Rule')
						.setCta()
						.onClick(async () => {
							if (!this.plugin.settings.tagAutomations) {
								this.plugin.settings.tagAutomations = [];
							}
							this.plugin.settings.tagAutomations.push({
								tag: '',
								boardId: '',
								listId: '',
							});
							await this.plugin.saveSettings();
							this.display();
						});
				});

			if (
				this.plugin.settings.tagAutomations &&
				this.plugin.settings.tagAutomations.length > 0
			) {
				this.plugin.settings.tagAutomations.forEach((rule, index) => {
					const ruleSetting = new Setting(containerEl).setName(
						`Tag Rule #${index + 1}`,
					);

					ruleSetting.addDropdown((drop) => {
						drop.addOption('', '-- Select Tag --');
						allObsidianTags.forEach((t) => drop.addOption(t, t));
						drop.setValue(rule.tag);
						drop.onChange(async (val) => {
							rule.tag = val;
							await this.plugin.saveSettings();
						});
					});

					ruleSetting.addDropdown((drop) => {
						drop.addOption('', '-- Board --');
						boards.forEach((b) => drop.addOption(b.id, b.name));
						drop.setValue(rule.boardId);
						drop.onChange(async (val) => {
							rule.boardId = val;
							rule.listId = '';
							await this.plugin.saveSettings();
							this.display();
						});
					});

					const lists = rule.boardId
						? listsByBoard.get(rule.boardId) || []
						: [];
					ruleSetting.addDropdown((drop) => {
						drop.addOption('', '-- List --');
						lists.forEach((l) => drop.addOption(l.id, l.name));
						drop.setValue(rule.listId);
						drop.onChange(async (val) => {
							rule.listId = val;
							await this.plugin.saveSettings();
						});
					});

					ruleSetting.addButton((btn) => {
						btn.setIcon('trash').onClick(async () => {
							this.plugin.settings.tagAutomations.splice(
								index,
								1,
							);
							await this.plugin.saveSettings();
							this.display();
						});
						btn.buttonEl.addClass('mod-warning');
					});
				});
			}

			// --- Folder to Trello List Section ---
			new Setting(containerEl)
				.setName('Auto-Add Folder Items names to a Trello List')
				.setHeading();

			new Setting(containerEl)
				.setName('Sync all Subfolders and Notes names to a list ')
				.setDesc(
					'If you have a Projects folder for example then everytime you move notes and folders from or into it , the plugin will update it in a trello list you choose ',
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
					.addDropdown((dropdown) => {
						dropdown.addOption('', '-- Select Board --');
						boards.forEach((board) =>
							dropdown.addOption(board.id, board.name),
						);
						dropdown.setValue(selectedBoardId);
						dropdown.onChange(async (value) => {
							this.plugin.settings.folderToTrelloBoardId = value;
							this.plugin.settings.folderToTrelloListId = '';
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
								.addDropdown((dropdown) => {
									dropdown.addOption('', '-- Select List --');
									lists.forEach((list) =>
										dropdown.addOption(list.id, list.name),
									);
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
