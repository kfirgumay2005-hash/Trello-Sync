import { Notice, Plugin, requestUrl, TFile, TFolder } from 'obsidian';
import {
	BoardMapping,
	DEFAULT_SETTINGS,
	TrelloPluginSettings,
	TrelloSyncSettingTab,
} from './settings';

export interface TrelloBoard {
	id: string;
	name: string;
	closed?: boolean;
}

export interface TrelloList {
	id: string;
	name: string;
}

export interface TrelloCard {
	id: string;
	name: string;
	idList: string;
	desc?: string;
	closed: boolean;
	dueComplete?: boolean;
}

export default class TrelloSyncPlugin extends Plugin {
	settings!: TrelloPluginSettings;
	syncTimerId: number | null = null;
	knownCardIdsByMapping: Map<string, Set<string>> = new Map();
	lastKnownCardStatus: Map<string, boolean> = new Map();

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon('folder-sync', 'Sync Trello Boards', () => {
			void this.syncAllBoards();
		});

		this.addCommand({
			id: 'sync-trello-board',
			name: 'Sync Selected Trello Boards',
			callback: () => {
				void this.syncAllBoards();
			},
		});

		this.addSettingTab(new TrelloSyncSettingTab(this.app, this));

		this.setupSyncInterval();
	}

	onunload() {
		if (this.syncTimerId !== null) {
			window.clearInterval(this.syncTimerId);
		}
	}

	setupSyncInterval() {
		if (this.syncTimerId !== null) {
			window.clearInterval(this.syncTimerId);
			this.syncTimerId = null;
		}

		if (!this.settings.apiKey || !this.settings.apiToken) {
			return;
		}

		const seconds = this.settings.syncIntervalSeconds || 30;
		const intervalMs = seconds * 1000;

		this.syncTimerId = this.registerInterval(
			window.setInterval(() => {
				void this.syncAllBoards(true);
			}, intervalMs),
		);
	}

	async getTrelloBoards(): Promise<TrelloBoard[]> {
		const { apiKey, apiToken } = this.settings;
		const url = `https://api.trello.com/1/members/me/boards?key=${apiKey}&token=${apiToken}&fields=name,id,closed&filter=open`;

		const response = await requestUrl({
			url: url,
			method: 'GET',
			headers: { Accept: 'application/json' },
		});

		const boards = response.json as TrelloBoard[];
		return boards.filter((board) => !board.closed);
	}

	async getBoardLists(boardId: string): Promise<TrelloList[]> {
		const { apiKey, apiToken } = this.settings;
		const url = `https://api.trello.com/1/boards/${boardId}/lists?key=${apiKey}&token=${apiToken}&fields=name,id`;

		const response = await requestUrl({
			url: url,
			method: 'GET',
			headers: { Accept: 'application/json' },
		});

		return response.json as TrelloList[];
	}

	async getBoardCards(boardId: string): Promise<TrelloCard[]> {
		const { apiKey, apiToken } = this.settings;
		const url = `https://api.trello.com/1/boards/${boardId}/cards?key=${apiKey}&token=${apiToken}&fields=name,idList,desc,closed,dueComplete`;

		const response = await requestUrl({
			url: url,
			method: 'GET',
			headers: { Accept: 'application/json' },
		});

		return response.json as TrelloCard[];
	}

	async createTrelloCard(name: string, listId: string): Promise<TrelloCard> {
		const { apiKey, apiToken } = this.settings;
		const url = `https://api.trello.com/1/cards?key=${apiKey}&token=${apiToken}&idList=${listId}&name=${encodeURIComponent(name)}`;

		const response = await requestUrl({
			url: url,
			method: 'POST',
			headers: { Accept: 'application/json' },
		});

		return response.json as TrelloCard;
	}

	async deleteTrelloCard(cardId: string) {
		const { apiKey, apiToken } = this.settings;
		const url = `https://api.trello.com/1/cards/${cardId}?key=${apiKey}&token=${apiToken}`;

		await requestUrl({
			url: url,
			method: 'DELETE',
			headers: { Accept: 'application/json' },
		});
	}

	async archiveTrelloCard(cardId: string) {
		const { apiKey, apiToken } = this.settings;
		const url = `https://api.trello.com/1/cards/${cardId}?key=${apiKey}&token=${apiToken}&closed=true`;

		await requestUrl({
			url: url,
			method: 'PUT',
			headers: { Accept: 'application/json' },
		});
	}

	async updateTrelloCardStatus(cardId: string, isComplete: boolean) {
		const { apiKey, apiToken } = this.settings;
		const url = `https://api.trello.com/1/cards/${cardId}?key=${apiKey}&token=${apiToken}&dueComplete=${isComplete}`;

		await requestUrl({
			url: url,
			method: 'PUT',
			headers: { Accept: 'application/json' },
		});
	}

	private getTargetFile(path: string): TFile | null {
		if (path) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				return file;
			}
		}
		return null;
	}

	async syncAllBoards(isBackground = false) {
		const { apiKey, apiToken, boardMappings } = this.settings;

		if (!apiKey || !apiToken) {
			if (!isBackground) {
				new Notice('⚠️ Please configure API credentials in settings.');
			}
			return;
		}

		if (!isBackground) {
			new Notice('Syncing Trello boards...');
		}

		for (const mapping of boardMappings) {
			if (mapping && mapping.boardId) {
				await this.syncSingleMapping(mapping, isBackground);
			}
		}

		if (this.settings.enableFolderToTrello) {
			await this.syncFolderToTrelloList();
		}
	}

	async syncSingleMapping(mapping: BoardMapping, isBackground: boolean) {
		const { deleteBehavior } = this.settings;
		const boardId = mapping.boardId;
		const mappingKey = `${boardId}::${mapping.targetNotePath}`;

		try {
			const boards = await this.getTrelloBoards();
			const currentBoard = boards.find((b) => b.id === boardId);
			const boardName = currentBoard ? currentBoard.name : 'Trello Board';

			const existingFile = this.getTargetFile(mapping.targetNotePath);

			const lists = await this.getBoardLists(boardId);
			let cards = await this.getBoardCards(boardId);

			const defaultFallbackListId = lists[0]?.id || '';

			let existingContent = '';
			let extraUserContent = '';

			let knownCardIds =
				this.knownCardIdsByMapping.get(mappingKey) || new Set<string>();

			if (existingFile) {
				existingContent = await this.app.vault.read(existingFile);

				const presentCardIds = new Set<string>();
				const idExtractRegex = /<!-- id:([a-zA-Z0-9]+) -->/g;
				let idMatch: RegExpExecArray | null;

				while (
					(idMatch = idExtractRegex.exec(existingContent)) !== null
				) {
					if (idMatch[1]) {
						presentCardIds.add(idMatch[1]);
					}
				}

				if (knownCardIds.size > 0) {
					for (const knownId of knownCardIds) {
						if (!presentCardIds.has(knownId)) {
							try {
								if (deleteBehavior === 'delete') {
									await this.deleteTrelloCard(knownId);
								} else {
									await this.archiveTrelloCard(knownId);
								}
								cards = cards.filter((c) => c.id !== knownId);
							} catch (err: unknown) {
								const errMsg =
									err instanceof Error
										? err.message
										: String(err);
								console.error(
									`Failed to remove/archive card ${knownId} in Trello:`,
									errMsg,
								);
							}
						}
					}
				}

				knownCardIds = presentCardIds;

				const lines = existingContent.split('\n');
				let currentListId = defaultFallbackListId;

				for (const line of lines) {
					const headerMatch = line.match(/^##\s+(.*)$/);
					if (headerMatch && headerMatch[1]) {
						const sectionTitle = headerMatch[1]
							.trim()
							.toLowerCase();
						const matchedList = lists.find(
							(l) => l.name.trim().toLowerCase() === sectionTitle,
						);
						if (matchedList) {
							currentListId = matchedList.id;
						}
					}

					const newCardMatch = line.match(
						/^- \[(x|X| )\] (.*?)(?: <!-- id:.*-->)?$/,
					);
					if (newCardMatch && !line.includes('<!-- id:')) {
						const rawCardName = newCardMatch[2];
						const cardName = rawCardName ? rawCardName.trim() : '';
						const isCheckedInObsidian =
							newCardMatch[1]?.toLowerCase() === 'x';

						if (cardName && currentListId) {
							try {
								const newCard = await this.createTrelloCard(
									cardName,
									currentListId,
								);
								if (isCheckedInObsidian) {
									await this.updateTrelloCardStatus(
										newCard.id,
										true,
									);
									newCard.dueComplete = true;
								}
								cards.push(newCard);
								knownCardIds.add(newCard.id);
								this.lastKnownCardStatus.set(
									`${mappingKey}::${newCard.id}`,
									isCheckedInObsidian,
								);
							} catch (err: unknown) {
								const errMsg =
									err instanceof Error
										? err.message
										: String(err);
								console.error(
									`Failed to create card "${cardName}" in Trello:`,
									errMsg,
								);
							}
						}
					}
				}

				const lineRegex =
					/- \[(x|X| )\] (.*?) <!-- id:([a-zA-Z0-9]+) -->/g;
				let match: RegExpExecArray | null;

				while ((match = lineRegex.exec(existingContent)) !== null) {
					const isCheckedInObsidian = match[1]?.toLowerCase() === 'x';
					const cardId = match[3];

					if (!cardId) continue;

					const currentCard = cards.find((c) => c.id === cardId);
					if (!currentCard) continue;

					const isDoneInTrello = !!currentCard.dueComplete;
					const statusKey = `${mappingKey}::${cardId}`;
					const wasChecked = this.lastKnownCardStatus.get(statusKey);

					if (isCheckedInObsidian !== isDoneInTrello) {
						if (wasChecked !== undefined) {
							const obsidianChanged =
								isCheckedInObsidian !== wasChecked;
							const trelloChanged = isDoneInTrello !== wasChecked;

							if (obsidianChanged && !trelloChanged) {
								try {
									await this.updateTrelloCardStatus(
										cardId,
										isCheckedInObsidian,
									);
									currentCard.dueComplete =
										isCheckedInObsidian;
									this.lastKnownCardStatus.set(
										statusKey,
										isCheckedInObsidian,
									);
								} catch (err: unknown) {
									const errMsg =
										err instanceof Error
											? err.message
											: String(err);
									console.error(
										`Failed to update Trello card ${cardId}:`,
										errMsg,
									);
								}
							} else {
								this.lastKnownCardStatus.set(
									statusKey,
									isDoneInTrello,
								);
							}
						} else {
							this.lastKnownCardStatus.set(
								statusKey,
								isDoneInTrello,
							);
						}
					} else {
						this.lastKnownCardStatus.set(statusKey, isDoneInTrello);
					}
				}

				const endMarker = '<!-- END TRELLO SYNC -->';
				if (existingContent.includes(endMarker)) {
					extraUserContent = (
						existingContent.split(endMarker)[1] || ''
					).replace(/^[\r\n]+/, '');
				} else if (existingContent.trim()) {
					extraUserContent = existingContent.replace(/^[\r\n]+/, '');
				}
			}

			let trelloSection = `# ${boardName}\n\n`;
			trelloSection += `*Synced from Trello on ${new Date().toLocaleString()}*\n\n---\n\n`;

			for (const list of lists) {
				trelloSection += `## ${list.name}\n\n`;
				const listCards = cards.filter(
					(c) => c.idList === list.id && !c.closed,
				);

				if (listCards.length === 0) {
					trelloSection += `*(No active cards)*\n\n`;
				} else {
					for (const card of listCards) {
						const isChecked = card.dueComplete ? 'x' : ' ';
						trelloSection += `- [${isChecked}] ${card.name} <!-- id:${card.id} -->\n`;
						knownCardIds.add(card.id);
						this.lastKnownCardStatus.set(
							`${mappingKey}::${card.id}`,
							!!card.dueComplete,
						);

						if (card.desc && card.desc.trim() !== '') {
							const indentedDesc = card.desc
								.split('\n')
								.map((line) => `  > ${line}`)
								.join('\n');
							trelloSection += `${indentedDesc}\n`;
						}
					}
					trelloSection += `\n`;
				}
			}

			trelloSection += `<!-- END TRELLO SYNC -->`;

			this.knownCardIdsByMapping.set(mappingKey, knownCardIds);

			const fullMarkdownContent = extraUserContent
				? `${trelloSection}\n\n${extraUserContent}`
				: `${trelloSection}\n`;

			let targetFile: TFile;
			if (existingFile) {
				await this.app.vault.modify(existingFile, fullMarkdownContent);
				targetFile = existingFile;
			} else {
				const fileName = `Trello - ${boardName}.md`;
				const fallback = this.app.vault.getAbstractFileByPath(fileName);

				if (fallback instanceof TFile) {
					await this.app.vault.modify(fallback, fullMarkdownContent);
					targetFile = fallback;
				} else {
					targetFile = await this.app.vault.create(
						fileName,
						fullMarkdownContent,
					);
				}

				mapping.targetNotePath = targetFile.path;
				await this.saveSettings();
			}

			if (!isBackground) {
				new Notice(
					`✅ Synced board "${boardName}" to note: ${targetFile.name}`,
				);
			}
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error('Trello Sync Error:', errorMessage);
			if (!isBackground) {
				new Notice(
					'❌ Failed to sync Trello board. Check console for details.',
				);
			}
		}
	}

	async syncFolderToTrelloList() {
		const {
			enableFolderToTrello,
			folderToTrelloSourceFolder,
			folderToTrelloBoardId,
			folderToTrelloListId,
			deleteBehavior,
		} = this.settings;

		if (
			!enableFolderToTrello ||
			!folderToTrelloSourceFolder ||
			!folderToTrelloBoardId ||
			!folderToTrelloListId
		) {
			return;
		}

		const sourceAbstract = this.app.vault.getAbstractFileByPath(
			folderToTrelloSourceFolder,
		);
		if (!(sourceAbstract instanceof TFolder)) {
			return;
		}

		try {
			// 1. שליפת כל הכרטיסים בלוח וסינון הכרטיסים הפעילים בעמודה שנבחרה
			const allCards = await this.getBoardCards(folderToTrelloBoardId);
			const listCards = allCards.filter(
				(c) => c.idList === folderToTrelloListId && !c.closed,
			);

			// מיפוי של שמות הכרטיסים הקיימים בטרלו
			const trelloCardNamesMap = new Map<string, TrelloCard>();
			for (const card of listCards) {
				trelloCardNamesMap.set(card.name.trim().toLowerCase(), card);
			}

			// 2. איסוף כל הפתקים והתת-תיקיות הקיימים בתיקיית המקור באובסידיאן
			const obsidianItemsMap = new Map<string, string>(); // normalizedName -> originalName
			for (const child of sourceAbstract.children) {
				let itemName = '';

				if (child instanceof TFile && child.extension === 'md') {
					itemName = child.basename;
				} else if (child instanceof TFolder) {
					itemName = child.name;
				}

				if (itemName) {
					obsidianItemsMap.set(
						itemName.trim().toLowerCase(),
						itemName,
					);
				}
			}

			// 3. הסרה/ארכוב של כרטיסים בטרלו שאינם קיימים עוד בתיקייה באובסידיאן
			for (const card of listCards) {
				const normalizedCardName = card.name.trim().toLowerCase();
				if (!obsidianItemsMap.has(normalizedCardName)) {
					try {
						if (deleteBehavior === 'delete') {
							await this.deleteTrelloCard(card.id);
						} else {
							await this.archiveTrelloCard(card.id);
						}
					} catch (err: unknown) {
						const errMsg =
							err instanceof Error ? err.message : String(err);
						console.error(
							`Failed to remove/archive card "${card.name}" in Trello:`,
							errMsg,
						);
					}
				}
			}

			// 4. יצירת כרטיסים חדשים בטרלו עבור פריטים חדשים שנוספו באובסידיאן
			for (const [
				normalizedName,
				originalName,
			] of obsidianItemsMap.entries()) {
				if (!trelloCardNamesMap.has(normalizedName)) {
					try {
						await this.createTrelloCard(
							originalName,
							folderToTrelloListId,
						);
					} catch (err: unknown) {
						const errMsg =
							err instanceof Error ? err.message : String(err);
						console.error(
							`Failed to create Trello card for "${originalName}":`,
							errMsg,
						);
					}
				}
			}
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error('Folder to Trello Sync Error:', errorMessage);
		}
	}

	async loadSettings() {
		const loadedData = (await this.loadData()) as Record<
			string,
			unknown
		> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);

		if (!this.settings.boardMappings) {
			this.settings.boardMappings = [];
		}

		if (
			loadedData?.selectedBoardId &&
			this.settings.boardMappings.length === 0
		) {
			this.settings.boardMappings.push({
				boardId: String(loadedData.selectedBoardId),
				targetNotePath: String(loadedData.targetNotePath || ''),
			});
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
