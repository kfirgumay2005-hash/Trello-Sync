import { Notice, Plugin, requestUrl, TFile } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	TrelloPluginSettings,
	TrelloSyncSettingTab,
} from './settings';

export interface TrelloBoard {
	id: string;
	name: string;
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
	knownCardIds: Set<string> = new Set();

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon('folder-sync', 'Sync Trello Board', () => {
			void this.syncSelectedBoard();
		});

		this.addCommand({
			id: 'sync-trello-board',
			name: 'Sync Selected Trello Board',
			callback: () => {
				void this.syncSelectedBoard();
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
				void this.syncSelectedBoard(true);
			}, intervalMs),
		);
	}

	async getTrelloBoards(): Promise<TrelloBoard[]> {
		const { apiKey, apiToken } = this.settings;
		const url = `https://api.trello.com/1/members/me/boards?key=${apiKey}&token=${apiToken}&fields=name,id`;

		const response = await requestUrl({
			url: url,
			method: 'GET',
			headers: { Accept: 'application/json' },
		});

		return response.json as TrelloBoard[];
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

	private getTargetFile(): TFile | null {
		const targetPath = this.settings.targetNotePath;
		if (targetPath) {
			const file = this.app.vault.getAbstractFileByPath(targetPath);
			if (file instanceof TFile) {
				return file;
			}
		}
		return null;
	}

	async syncSelectedBoard(isBackground = false) {
		const { apiKey, apiToken, selectedBoardId, deleteBehavior } =
			this.settings;

		if (!apiKey || !apiToken || !selectedBoardId) {
			if (!isBackground) {
				new Notice(
					'⚠️ Please configure API credentials and Board in settings.',
				);
			}
			return;
		}

		if (!isBackground) {
			new Notice('Syncing Trello board...');
		}

		try {
			const boards = await this.getTrelloBoards();
			const currentBoard = boards.find((b) => b.id === selectedBoardId);
			const boardName = currentBoard ? currentBoard.name : 'Trello Board';

			const existingFile = this.getTargetFile();

			const lists = await this.getBoardLists(selectedBoardId);
			let cards = await this.getBoardCards(selectedBoardId);

			const defaultFallbackListId = lists[0]?.id || '';

			let existingContent = '';
			let extraUserContent = '';

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

				if (this.knownCardIds.size > 0) {
					for (const knownId of this.knownCardIds) {
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

				this.knownCardIds = presentCardIds;

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

						if (cardName && currentListId) {
							try {
								const newCard = await this.createTrelloCard(
									cardName,
									currentListId,
								);
								cards.push(newCard);
								this.knownCardIds.add(newCard.id);
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

					if (isCheckedInObsidian !== isDoneInTrello) {
						try {
							await this.updateTrelloCardStatus(
								cardId,
								isCheckedInObsidian,
							);
							currentCard.dueComplete = isCheckedInObsidian;
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
					}
				}

				const endMarker = '<!-- END TRELLO SYNC -->';
				if (existingContent.includes(endMarker)) {
					extraUserContent =
						existingContent.split(endMarker)[1] || '';
				} else {
					extraUserContent = `\n${existingContent}`;
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
						this.knownCardIds.add(card.id);

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

			trelloSection += `<!-- END TRELLO SYNC -->\n`;

			const fullMarkdownContent = extraUserContent
				? `${trelloSection}${extraUserContent}`
				: trelloSection;

			let targetFile: TFile;
			if (existingFile) {
				await this.app.vault.modify(existingFile, fullMarkdownContent);
				targetFile = existingFile;
				if (!isBackground) {
					new Notice(
						`✅ Updated existing note: ${existingFile.name}`,
					);
				}
			} else {
				const fileName = 'Trello sync.md';
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

				this.settings.targetNotePath = targetFile.path;
				await this.saveSettings();

				if (!isBackground) {
					new Notice(`✅ Created new note: ${fileName}`);
				}
			}

			if (!isBackground) {
				await this.app.workspace.getLeaf().openFile(targetFile);
			}
		} catch (error: unknown) {
			// Solves the warning: "Unsafe assignment of an error or any typed value"
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

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
