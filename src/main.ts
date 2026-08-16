import {
	Notice,
	Plugin,
	requestUrl,
	TFile,
	TFolder,
	Modal,
	App,
	Setting,
} from 'obsidian';
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

export interface TrelloLabel {
	id: string;
	name: string;
	color: string | null;
}

export interface TrelloCard {
	id: string;
	name: string;
	idList: string;
	desc?: string;
	closed: boolean;
	dueComplete?: boolean;
	start?: string;
	due?: string;
	labels?: TrelloLabel[];
	idLabels?: string[];
}

export default class TrelloSyncPlugin extends Plugin {
	settings!: TrelloPluginSettings;
	syncTimerId: number | null = null;
	knownCardIdsByMapping: Map<string, Set<string>> = new Map();
	lastKnownCardStatus: Map<string, boolean> = new Map();
	lastKnownCardDates: Map<string, { start: string; due: string }> = new Map();
	lastKnownCardLabels: Map<string, string[]> = new Map();

	async onload() {
		await this.loadSettings();

		// Create Card Ribbon Button
		this.addRibbonIcon('plus-circle', 'Create Trello Card', () => {
			new CreateTrelloCardModal(this.app, this).open();
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
		return (response.json as TrelloBoard[]).filter(
			(board) => !board.closed,
		);
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

	async getBoardLabels(boardId: string): Promise<TrelloLabel[]> {
		const { apiKey, apiToken } = this.settings;
		const url = `https://api.trello.com/1/boards/${boardId}/labels?key=${apiKey}&token=${apiToken}`;
		const response = await requestUrl({
			url: url,
			method: 'GET',
			headers: { Accept: 'application/json' },
		});
		return response.json as TrelloLabel[];
	}

	async createBoardLabel(
		boardId: string,
		name: string,
	): Promise<TrelloLabel> {
		const { apiKey, apiToken } = this.settings;
		const url = `https://api.trello.com/1/boards/${boardId}/labels?key=${apiKey}&token=${apiToken}&name=${encodeURIComponent(name)}&color=null`;
		const response = await requestUrl({
			url: url,
			method: 'POST',
			headers: { Accept: 'application/json' },
		});
		return response.json as TrelloLabel;
	}

	async syncCardLabels(
		boardId: string,
		cardId: string,
		desiredTags: string[],
		currentBoardLabels: TrelloLabel[],
	): Promise<string[]> {
		const labelIds: string[] = [];
		for (const tag of desiredTags) {
			const cleanTag = tag.replace('#', '').toLowerCase();
			let matchedLabel = currentBoardLabels.find(
				(l) => (l.name || '').toLowerCase() === cleanTag,
			);
			if (!matchedLabel) {
				matchedLabel = await this.createBoardLabel(boardId, cleanTag);
				currentBoardLabels.push(matchedLabel);
			}
			labelIds.push(matchedLabel.id);
		}
		await this.updateTrelloCard(cardId, { idLabels: labelIds });
		return labelIds;
	}

	async getBoardCards(boardId: string): Promise<TrelloCard[]> {
		const { apiKey, apiToken } = this.settings;
		const url = `https://api.trello.com/1/boards/${boardId}/cards?key=${apiKey}&token=${apiToken}&fields=name,idList,desc,closed,dueComplete,start,due,labels,idLabels`;
		const response = await requestUrl({
			url: url,
			method: 'GET',
			headers: { Accept: 'application/json' },
		});
		return response.json as TrelloCard[];
	}

	async createTrelloCard(
		name: string,
		listId: string,
		start?: string,
		due?: string,
	): Promise<TrelloCard> {
		const { apiKey, apiToken } = this.settings;
		let url = `https://api.trello.com/1/cards?key=${apiKey}&token=${apiToken}&idList=${listId}&name=${encodeURIComponent(name)}`;

		if (start) url += `&start=${start}`;
		if (due) url += `&due=${due}`;

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

	async updateTrelloCard(
		cardId: string,
		props: {
			isComplete?: boolean;
			targetListId?: string;
			start?: string;
			due?: string;
			idLabels?: string[];
		},
	) {
		const { apiKey, apiToken } = this.settings;
		let url = `https://api.trello.com/1/cards/${cardId}?key=${apiKey}&token=${apiToken}`;

		if (props.isComplete !== undefined)
			url += `&dueComplete=${props.isComplete}`;
		if (props.targetListId) url += `&idList=${props.targetListId}`;
		if (props.start !== undefined) url += `&start=${props.start || 'null'}`;
		if (props.due !== undefined) url += `&due=${props.due || 'null'}`;
		if (props.idLabels !== undefined)
			url += `&idLabels=${props.idLabels.join(',')}`;

		await requestUrl({
			url: url,
			method: 'PUT',
			headers: { Accept: 'application/json' },
		});
	}

	private getTargetFile(path: string): TFile | null {
		if (path) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) return file;
		}
		return null;
	}

	async syncAllBoards(isBackground = false) {
		const { apiKey, apiToken, boardMappings, tagAutomations } =
			this.settings;

		if (!apiKey || !apiToken) {
			if (!isBackground)
				new Notice('⚠️ Please configure API credentials in settings.');
			return;
		}

		for (const mapping of boardMappings) {
			if (mapping && mapping.boardId) {
				await this.syncSingleMapping(mapping, isBackground);
			}
		}

		if (this.settings.enableFolderToTrello) {
			await this.syncFolderToTrelloList();
		}

		if (tagAutomations && tagAutomations.length > 0) {
			await this.syncTagAutomations();
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

			const boardLabels = await this.getBoardLabels(boardId);
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
					if (idMatch[1]) presentCardIds.add(idMatch[1]);
				}

				if (knownCardIds.size > 0) {
					for (const knownId of knownCardIds) {
						if (!presentCardIds.has(knownId)) {
							try {
								if (deleteBehavior === 'delete')
									await this.deleteTrelloCard(knownId);
								else await this.archiveTrelloCard(knownId);
								cards = cards.filter((c) => c.id !== knownId);
							} catch (err: unknown) {
								console.error(
									`Failed to remove/archive card ${knownId} in Trello.`,
									err,
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
						if (matchedList) currentListId = matchedList.id;
					}

					const newCardMatch = line.match(
						/^- \[(x|X| )\] (.*?)(?: <!-- id:.*-->)?$/,
					);
					if (newCardMatch && !line.includes('<!-- id:')) {
						let rawCardName = newCardMatch[2] || '';
						let obsStart = '';
						let obsDue = '';

						const startM = rawCardName.match(
							/🛫 (\d{4}-\d{2}-\d{2})/,
						);
						if (startM && startM[1]) {
							obsStart = startM[1];
							rawCardName = rawCardName.replace(startM[0], '');
						}
						const dueM = rawCardName.match(
							/📅 (\d{4}-\d{2}-\d{2})/,
						);
						if (dueM && dueM[1]) {
							obsDue = dueM[1];
							rawCardName = rawCardName.replace(dueM[0], '');
						}

						// זיהוי תגיות (תומך בעברית, ללא רווחים)
						const obsTags: string[] = [];
						const tagRegex = /#([^\s#]+)/g;
						let tagMatch;
						while (
							(tagMatch = tagRegex.exec(rawCardName)) !== null
						) {
							if (tagMatch && tagMatch[1]) {
								obsTags.push(tagMatch[1].toLowerCase());
							}
						}
						rawCardName = rawCardName
							.replace(tagRegex, '')
							.replace(/\s+/g, ' ')
							.trim();

						const cardName = rawCardName;
						const isCheckedInObsidian =
							newCardMatch[1]?.toLowerCase() === 'x';

						if (cardName && currentListId) {
							try {
								const newCard = await this.createTrelloCard(
									cardName,
									currentListId,
									obsStart,
									obsDue,
								);

								if (obsTags.length > 0) {
									await this.syncCardLabels(
										boardId,
										newCard.id,
										obsTags,
										boardLabels,
									);
								}

								if (isCheckedInObsidian) {
									let targetListForNewCard = undefined;
									if (
										mapping.enableMoveOnCheck &&
										mapping.automations
									) {
										const rule = mapping.automations.find(
											(a) =>
												a.sourceListId ===
												currentListId,
										);
										if (rule)
											targetListForNewCard =
												rule.targetListId;
									}

									await this.updateTrelloCard(newCard.id, {
										isComplete: true,
										targetListId: targetListForNewCard,
									});

									newCard.dueComplete = true;
									if (targetListForNewCard)
										newCard.idList = targetListForNewCard;
								}

								cards.push(newCard);
								knownCardIds.add(newCard.id);
								this.lastKnownCardStatus.set(
									`${mappingKey}::${newCard.id}`,
									isCheckedInObsidian,
								);
								this.lastKnownCardDates.set(
									`${mappingKey}::${newCard.id}`,
									{ start: obsStart, due: obsDue },
								);
								this.lastKnownCardLabels.set(
									`${mappingKey}::${newCard.id}`,
									obsTags,
								);
							} catch (err: unknown) {
								console.error(
									`Failed to create card "${cardName}" in Trello.`,
									err,
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
					let rawCardName = match[2] || '';
					const cardId = match[3];

					if (!cardId) continue;
					const currentCard = cards.find((c) => c.id === cardId);
					if (!currentCard) continue;

					let obsStart = '';
					let obsDue = '';
					const startM = rawCardName.match(/🛫 (\d{4}-\d{2}-\d{2})/);
					if (startM && startM[1]) {
						obsStart = startM[1];
						rawCardName = rawCardName.replace(startM[0], '');
					}
					const dueM = rawCardName.match(/📅 (\d{4}-\d{2}-\d{2})/);
					if (dueM && dueM[1]) {
						obsDue = dueM[1];
						rawCardName = rawCardName.replace(dueM[0], '');
					}

					const obsTags: string[] = [];
					const tagRegex = /#([^\s#]+)/g;
					let tagMatch;
					while ((tagMatch = tagRegex.exec(rawCardName)) !== null) {
						if (tagMatch && tagMatch[1]) {
							obsTags.push(tagMatch[1].toLowerCase());
						}
					}

					const isDoneInTrello = !!currentCard.dueComplete;
					const trelloStart = currentCard.start
						? currentCard.start.substring(0, 10)
						: '';
					const trelloDue = currentCard.due
						? currentCard.due.substring(0, 10)
						: '';

					const trelloTags = (currentCard.labels || [])
						.filter((l) => l.name)
						.map((l) => l.name.toLowerCase().replace(/\s+/g, '-'));

					const statusKey = `${mappingKey}::${cardId}`;
					const wasChecked = this.lastKnownCardStatus.get(statusKey);
					const lastDates = this.lastKnownCardDates.get(
						statusKey,
					) || { start: trelloStart, due: trelloDue };
					const lastTags =
						this.lastKnownCardLabels.get(statusKey) || trelloTags;

					const updateProps: {
						isComplete?: boolean;
						targetListId?: string;
						start?: string;
						due?: string;
						idLabels?: string[];
					} = {};

					if (obsStart !== lastDates.start)
						updateProps.start = obsStart;
					if (obsDue !== lastDates.due) updateProps.due = obsDue;

					const obsidianTagsChanged =
						JSON.stringify(obsTags.sort()) !==
						JSON.stringify(lastTags.sort());
					const trelloTagsChanged =
						JSON.stringify(trelloTags.sort()) !==
						JSON.stringify(lastTags.sort());

					if (obsidianTagsChanged && !trelloTagsChanged) {
						try {
							const newLabelIds = await this.syncCardLabels(
								boardId,
								cardId,
								obsTags,
								boardLabels,
							);
							currentCard.idLabels = newLabelIds;
							this.lastKnownCardLabels.set(statusKey, obsTags);
						} catch (err) {
							console.error(
								`Failed to update labels for card ${cardId}`,
								err,
							);
						}
					} else if (trelloTagsChanged) {
						this.lastKnownCardLabels.set(statusKey, trelloTags);
					} else {
						this.lastKnownCardLabels.set(statusKey, trelloTags);
					}

					if (isCheckedInObsidian !== isDoneInTrello) {
						if (wasChecked !== undefined) {
							const obsidianChanged =
								isCheckedInObsidian !== wasChecked;
							const trelloChanged = isDoneInTrello !== wasChecked;

							if (obsidianChanged && !trelloChanged) {
								updateProps.isComplete = isCheckedInObsidian;
								if (
									mapping.enableMoveOnCheck &&
									mapping.automations
								) {
									if (isCheckedInObsidian) {
										const rule = mapping.automations.find(
											(a) =>
												a.sourceListId ===
												currentCard.idList,
										);
										if (rule)
											updateProps.targetListId =
												rule.targetListId;
									} else {
										const rule = mapping.automations.find(
											(a) =>
												a.targetListId ===
												currentCard.idList,
										);
										if (rule)
											updateProps.targetListId =
												rule.sourceListId;
									}
								}
							} else if (trelloChanged) {
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

					if (Object.keys(updateProps).length > 0) {
						try {
							await this.updateTrelloCard(cardId, updateProps);

							if (updateProps.isComplete !== undefined) {
								currentCard.dueComplete =
									updateProps.isComplete;
								this.lastKnownCardStatus.set(
									statusKey,
									updateProps.isComplete,
								);
							}
							if (updateProps.targetListId) {
								currentCard.idList = updateProps.targetListId;
							}
							if (updateProps.start !== undefined) {
								currentCard.start = updateProps.start
									? `${updateProps.start}T00:00:00.000Z`
									: undefined;
								lastDates.start = updateProps.start;
							}
							if (updateProps.due !== undefined) {
								currentCard.due = updateProps.due
									? `${updateProps.due}T00:00:00.000Z`
									: undefined;
								lastDates.due = updateProps.due;
							}

							this.lastKnownCardDates.set(statusKey, lastDates);
						} catch (err: unknown) {
							console.error(
								`Failed to update Trello card ${cardId}`,
								err,
							);
						}
					} else {
						this.lastKnownCardDates.set(statusKey, {
							start: trelloStart,
							due: trelloDue,
						});
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

			if (mapping.enableMoveOnCheck && mapping.automations) {
				for (const card of cards) {
					let newTargetListId = undefined;
					const isDone = !!card.dueComplete;

					if (isDone) {
						const rule = mapping.automations.find(
							(a) => a.sourceListId === card.idList,
						);
						if (rule) newTargetListId = rule.targetListId;
					} else {
						const rule = mapping.automations.find(
							(a) => a.targetListId === card.idList,
						);
						if (rule) newTargetListId = rule.sourceListId;
					}

					if (newTargetListId) {
						try {
							await this.updateTrelloCard(card.id, {
								isComplete: isDone,
								targetListId: newTargetListId,
							});
							card.idList = newTargetListId;
						} catch (err: unknown) {
							console.error(
								`Failed to enforce list automation for card ${card.id}`,
								err,
							);
						}
					}
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
						let dateStr = '';
						const tStart = card.start
							? card.start.substring(0, 10)
							: '';
						const tDue = card.due ? card.due.substring(0, 10) : '';
						if (tStart) dateStr += ` 🛫 ${tStart}`;
						if (tDue) dateStr += ` 📅 ${tDue}`;

						let tagsStr = '';
						const tTags = (card.labels || [])
							.filter((l) => l.name)
							.map(
								(l) =>
									`#${l.name.toLowerCase().replace(/\s+/g, '-')}`,
							);

						if (tTags.length > 0) {
							tagsStr = ` ${tTags.join(' ')}`;
						}

						trelloSection += `- [${isChecked}] ${card.name}${dateStr}${tagsStr} <!-- id:${card.id} -->\n`;

						knownCardIds.add(card.id);
						this.lastKnownCardStatus.set(
							`${mappingKey}::${card.id}`,
							!!card.dueComplete,
						);
						this.lastKnownCardDates.set(
							`${mappingKey}::${card.id}`,
							{ start: tStart, due: tDue },
						);
						this.lastKnownCardLabels.set(
							`${mappingKey}::${card.id}`,
							tTags.map((t) => t.replace('#', '')),
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
				// אופטימיזציה ל-SSD: כותב לקובץ רק אם התוכן השתנה בפועל
				if (existingContent !== fullMarkdownContent) {
					await this.app.vault.modify(
						existingFile,
						fullMarkdownContent,
					);
				}
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
		} catch (error: unknown) {
			console.error('Trello Sync Error:', error);
		}
	}

	async syncFolderToTrelloList() {
		const {
			enableFolderToTrello,
			folderToTrelloSourceFolder,
			folderToTrelloBoardId,
			folderToTrelloListId,
			deleteBehavior,
			boardMappings,
		} = this.settings;

		if (
			!enableFolderToTrello ||
			!folderToTrelloSourceFolder ||
			!folderToTrelloBoardId ||
			!folderToTrelloListId
		)
			return;

		const sourceAbstract = this.app.vault.getAbstractFileByPath(
			folderToTrelloSourceFolder,
		);
		if (!(sourceAbstract instanceof TFolder)) return;

		try {
			const allCards = await this.getBoardCards(folderToTrelloBoardId);
			const allActiveCards = allCards.filter((c) => !c.closed);

			const trelloCardNamesMap = new Map<string, TrelloCard>();
			for (const card of allActiveCards) {
				trelloCardNamesMap.set(card.name.trim().toLowerCase(), card);
			}

			const listCards = allActiveCards.filter(
				(c) => c.idList === folderToTrelloListId,
			);
			const obsidianItemsMap = new Map<string, string>();

			const mappedNotePaths = new Set(
				boardMappings.map((m) => m.targetNotePath),
			);

			for (const child of sourceAbstract.children) {
				let itemName = '';
				if (
					child instanceof TFile &&
					child.extension === 'md' &&
					!mappedNotePaths.has(child.path)
				) {
					itemName = child.basename;
				} else if (child instanceof TFolder) {
					itemName = child.name;
				}

				if (itemName)
					obsidianItemsMap.set(
						itemName.trim().toLowerCase(),
						itemName,
					);
			}

			const allFiles = this.app.vault
				.getMarkdownFiles()
				.filter((f) => !mappedNotePaths.has(f.path));
			const allFileNames = new Set(
				allFiles.map((f) => f.basename.trim().toLowerCase()),
			);

			for (const card of listCards) {
				const normalizedCardName = card.name.trim().toLowerCase();
				// מוחק רק אם מדובר בפתק שקיים באובסידיאן והוא כבר לא בתיקייה (מונע מחיקה של כרטיסים שנוצרו ידנית בטרלו)
				if (
					allFileNames.has(normalizedCardName) &&
					!obsidianItemsMap.has(normalizedCardName)
				) {
					try {
						if (deleteBehavior === 'delete')
							await this.deleteTrelloCard(card.id);
						else await this.archiveTrelloCard(card.id);
					} catch (err: unknown) {
						console.error(
							`Failed to remove/archive card "${card.name}" in Trello`,
							err,
						);
					}
				}
			}

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
						console.error(
							`Failed to create Trello card for "${originalName}"`,
							err,
						);
					}
				}
			}
		} catch (error: unknown) {
			console.error('Folder to Trello Sync Error:', error);
		}
	}

	async syncTagAutomations() {
		const { deleteBehavior, tagAutomations, boardMappings } = this.settings;
		if (!tagAutomations || tagAutomations.length === 0) return;

		const mappedNotePaths = new Set(
			boardMappings.map((m) => m.targetNotePath),
		);
		const allFiles = this.app.vault
			.getMarkdownFiles()
			.filter((f) => !mappedNotePaths.has(f.path));
		const allFileNames = new Set(
			allFiles.map((f) => f.basename.trim().toLowerCase()),
		);

		for (const automation of tagAutomations) {
			if (!automation.tag || !automation.boardId || !automation.listId)
				continue;

			const cleanTag = automation.tag.startsWith('#')
				? automation.tag
				: `#${automation.tag}`;
			const tagWithoutHash = cleanTag.substring(1).toLowerCase();

			const taggedFiles = allFiles.filter((file) => {
				const cache = this.app.metadataCache.getFileCache(file);
				if (!cache) return false;

				if (
					cache.tags?.some(
						(t) => t.tag.toLowerCase() === cleanTag.toLowerCase(),
					)
				)
					return true;

				const fmTags = cache.frontmatter?.tags as
					| string
					| string[]
					| undefined;
				if (fmTags) {
					const tagsArr = Array.isArray(fmTags) ? fmTags : [fmTags];
					if (
						tagsArr.some(
							(t) =>
								String(t).toLowerCase() === tagWithoutHash ||
								String(t).toLowerCase() ===
									cleanTag.toLowerCase(),
						)
					)
						return true;
				}
				return false;
			});

			try {
				const allCards = await this.getBoardCards(automation.boardId);
				const allActiveCards = allCards.filter((c) => !c.closed);
				const listCards = allActiveCards.filter(
					(c) => c.idList === automation.listId,
				);

				const cardNamesMap = new Map<string, TrelloCard>();
				for (const card of allActiveCards) {
					cardNamesMap.set(card.name.trim().toLowerCase(), card);
				}

				const taggedItemsMap = new Map<string, string>();
				for (const file of taggedFiles) {
					taggedItemsMap.set(
						file.basename.trim().toLowerCase(),
						file.basename,
					);
				}

				for (const card of listCards) {
					const normName = card.name.trim().toLowerCase();
					// מוחק רק אם זה פתק אמיתי שקיים באובסידיאן, והוא כבר לא מתויג (מגן על כרטיסים אחרים)
					if (
						allFileNames.has(normName) &&
						!taggedItemsMap.has(normName)
					) {
						try {
							if (deleteBehavior === 'delete')
								await this.deleteTrelloCard(card.id);
							else await this.archiveTrelloCard(card.id);
						} catch (err: unknown) {
							console.error(
								`Failed to remove/archive tagged card "${card.name}"`,
								err,
							);
						}
					}
				}

				for (const [norm, orig] of taggedItemsMap.entries()) {
					if (!cardNamesMap.has(norm)) {
						try {
							const newCard = await this.createTrelloCard(
								orig,
								automation.listId,
							);
							const boardLabels = await this.getBoardLabels(
								automation.boardId,
							);
							await this.syncCardLabels(
								automation.boardId,
								newCard.id,
								[tagWithoutHash],
								boardLabels,
							);
						} catch (err: unknown) {
							console.error(
								`Failed to create Trello card for tagged note "${orig}"`,
								err,
							);
						}
					}
				}
			} catch (err: unknown) {
				console.error('Tag to Trello Sync Error:', err);
			}
		}
	}

	async loadSettings() {
		const loadedData = (await this.loadData()) as Record<
			string,
			unknown
		> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);

		if (!this.settings.boardMappings) this.settings.boardMappings = [];
		if (!this.settings.tagAutomations) this.settings.tagAutomations = [];

		if (
			loadedData?.selectedBoardId &&
			this.settings.boardMappings.length === 0
		) {
			this.settings.boardMappings.push({
				boardId: String(loadedData.selectedBoardId),
				targetNotePath: String(loadedData.targetNotePath || ''),
				automations: [],
			});
		}

		this.settings.boardMappings.forEach((mapping) => {
			if (!mapping.automations) mapping.automations = [];
			if (mapping.moveSourceListId && mapping.moveTargetListId) {
				mapping.automations.push({
					sourceListId: mapping.moveSourceListId,
					targetListId: mapping.moveTargetListId,
				});
				delete mapping.moveSourceListId;
				delete mapping.moveTargetListId;
			}
		});
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class CreateTrelloCardModal extends Modal {
	plugin: TrelloSyncPlugin;
	boards: TrelloBoard[] = [];
	lists: TrelloList[] = [];

	selectedBoardId: string = '';
	selectedListId: string = '';
	selectedTag: string = '';
	cardName: string = '';
	startDate: string = '';
	dueDate: string = '';

	listDropdownEl: HTMLElement | null = null;

	constructor(app: App, plugin: TrelloSyncPlugin) {
		super(app);
		this.plugin = plugin;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Create New Trello Card' });

		this.boards = await this.plugin.getTrelloBoards().catch(() => []);

		new Setting(contentEl).setName('Board').addDropdown((drop) => {
			drop.addOption('', '-- Select Board --');
			this.boards.forEach((b) => {
				drop.addOption(b.id, b.name);
			});
			drop.onChange((val) => {
				void (async () => {
					this.selectedBoardId = val;
					this.selectedListId = '';
					this.lists = await this.plugin
						.getBoardLists(val)
						.catch(() => []);
					this.renderListDropdown();
				})();
			});
		});

		this.listDropdownEl = contentEl.createDiv();
		this.renderListDropdown();

		new Setting(contentEl)
			.setName('Card Name')
			.addText((text) => text.onChange((val) => (this.cardName = val)));

		new Setting(contentEl)
			.setName('Label / Tag')
			.setDesc(
				'Type a tag to add to the card (will sync to Obsidian as #tag)',
			)
			.addText((text) => {
				text.setPlaceholder('e.g. urgent');
				text.onChange((val) => (this.selectedTag = val));
			});

		new Setting(contentEl).setName('Start Date').addText((text) => {
			text.inputEl.type = 'date';
			text.onChange((val) => (this.startDate = val));
		});

		new Setting(contentEl).setName('Due Date').addText((text) => {
			text.inputEl.type = 'date';
			text.onChange((val) => (this.dueDate = val));
		});

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText('Create Card')
				.setCta()
				.onClick(() => {
					void (async () => {
						if (!this.selectedListId || !this.cardName) {
							new Notice(
								'Please select a list and enter a card name.',
							);
							return;
						}
						btn.setButtonText('Creating...').setDisabled(true);
						try {
							const newCard = await this.plugin.createTrelloCard(
								this.cardName,
								this.selectedListId,
								this.startDate,
								this.dueDate,
							);

							if (this.selectedTag && this.selectedBoardId) {
								const boardLabels =
									await this.plugin.getBoardLabels(
										this.selectedBoardId,
									);
								const cleanTag = this.selectedTag
									.replace('#', '')
									.trim();
								if (cleanTag) {
									await this.plugin.syncCardLabels(
										this.selectedBoardId,
										newCard.id,
										[cleanTag],
										boardLabels,
									);
								}
							}

							new Notice('Trello Card Created!');
							this.close();
							void this.plugin.syncAllBoards(true);
						} catch (e) {
							console.error('Failed to create card:', e);
							new Notice('Failed to create card');
							btn.setButtonText('Create Card').setDisabled(false);
						}
					})();
				}),
		);
	}

	renderListDropdown() {
		if (!this.listDropdownEl) return;
		this.listDropdownEl.empty();
		new Setting(this.listDropdownEl).setName('List').addDropdown((drop) => {
			drop.addOption('', '-- Select List --');
			this.lists.forEach((l) => {
				drop.addOption(l.id, l.name);
			});
			drop.setValue(this.selectedListId);
			drop.onChange((val) => (this.selectedListId = val));
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
