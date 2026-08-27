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

export interface TrelloMember {
	id: string;
	fullName: string;
	username: string;
}

export interface TrelloCheckItem {
	id: string;
	name: string;
	state: 'complete' | 'incomplete';
}

export interface TrelloChecklist {
	id: string;
	name: string;
	checkItems: TrelloCheckItem[];
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
	members?: TrelloMember[];
	checklists?: TrelloChecklist[];
}

interface ObsParsedCard {
	id?: string;
	listId: string;
	isChecked: boolean;
	name: string;
	startDate: string;
	dueDate: string;
	tags: string[];
	members: string[];
	desc: string;
	checkItems: { name: string; checked: boolean }[];
}

interface ObsParsedList {
	id?: string;
	name: string;
}

interface ParsedObsidian {
	cards: ObsParsedCard[];
	lists: ObsParsedList[];
}

export default class TrelloSyncPlugin extends Plugin {
	settings!: TrelloPluginSettings;
	syncTimerId: number | null = null;
	knownCardIdsByMapping: Map<string, Set<string>> = new Map();
	lastKnownCardStatus: Map<string, boolean> = new Map();
	lastKnownCardDates: Map<string, { start: string; due: string }> = new Map();
	lastKnownCardLabels: Map<string, string[]> = new Map();

	lastKnownCardDesc: Map<string, string> = new Map();
	lastKnownCardMembers: Map<string, string[]> = new Map();
	lastKnownChecklistState: Map<string, boolean> = new Map();

	lastKnownCardName: Map<string, string> = new Map();
	lastKnownCardList: Map<string, string> = new Map();
	lastKnownListName: Map<string, string> = new Map();

	async onload() {
		await this.loadSettings();

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

	async getBoardMembers(boardId: string): Promise<TrelloMember[]> {
		const { apiKey, apiToken } = this.settings;
		const url = `https://api.trello.com/1/boards/${boardId}/members?key=${apiKey}&token=${apiToken}`;
		const response = await requestUrl({
			url: url,
			method: 'GET',
			headers: { Accept: 'application/json' },
		});
		return response.json as TrelloMember[];
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

	async updateTrelloList(listId: string, name: string) {
		const { apiKey, apiToken } = this.settings;
		const url = `https://api.trello.com/1/lists/${listId}?key=${apiKey}&token=${apiToken}`;
		await requestUrl({
			url: url,
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify({ name }),
		});
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
		const url = `https://api.trello.com/1/boards/${boardId}/cards?key=${apiKey}&token=${apiToken}&fields=name,idList,desc,closed,dueComplete,start,due,labels,idLabels&members=true&checklists=all`;
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
		desc?: string,
	): Promise<TrelloCard> {
		const { apiKey, apiToken } = this.settings;
		let url = `https://api.trello.com/1/cards?key=${apiKey}&token=${apiToken}&idList=${listId}&name=${encodeURIComponent(name)}`;
		if (start) url += `&start=${start}`;
		if (due) url += `&due=${due}`;

		const body: Record<string, string> = {};
		if (desc) body.desc = desc;

		const response = await requestUrl({
			url: url,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify(body),
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
			desc?: string;
			idMembers?: string[];
			name?: string;
		},
	) {
		const { apiKey, apiToken } = this.settings;
		const url = `https://api.trello.com/1/cards/${cardId}?key=${apiKey}&token=${apiToken}`;

		const body: Record<string, string | boolean | null> = {};
		if (props.isComplete !== undefined) body.dueComplete = props.isComplete;
		if (props.targetListId) body.idList = props.targetListId;
		if (props.start !== undefined) body.start = props.start || null;
		if (props.due !== undefined) body.due = props.due || null;
		if (props.idLabels !== undefined)
			body.idLabels = props.idLabels.join(',');
		if (props.desc !== undefined) body.desc = props.desc;
		if (props.idMembers !== undefined)
			body.idMembers = props.idMembers.join(',');
		if (props.name !== undefined) body.name = props.name;

		await requestUrl({
			url: url,
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify(body),
		});
	}

	async createChecklist(
		cardId: string,
		name: string,
	): Promise<TrelloChecklist> {
		const { apiKey, apiToken } = this.settings;
		const url = `https://api.trello.com/1/checklists?key=${apiKey}&token=${apiToken}&idCard=${cardId}&name=${encodeURIComponent(name)}`;
		const response = await requestUrl({
			url: url,
			method: 'POST',
			headers: { Accept: 'application/json' },
		});
		return response.json as TrelloChecklist;
	}

	async createChecklistItem(
		checklistId: string,
		name: string,
	): Promise<TrelloCheckItem> {
		const { apiKey, apiToken } = this.settings;
		const url = `https://api.trello.com/1/checklists/${checklistId}/checkItems?key=${apiKey}&token=${apiToken}&name=${encodeURIComponent(name)}`;
		const response = await requestUrl({
			url: url,
			method: 'POST',
			headers: { Accept: 'application/json' },
		});
		return response.json as TrelloCheckItem;
	}

	async updateChecklistItemState(
		cardId: string,
		idCheckItem: string,
		state: 'complete' | 'incomplete',
	) {
		const { apiKey, apiToken } = this.settings;
		const url = `https://api.trello.com/1/cards/${cardId}/checkItem/${idCheckItem}?key=${apiKey}&token=${apiToken}`;
		await requestUrl({
			url: url,
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify({ state }),
		});
	}

	async deleteChecklistItem(cardId: string, idCheckItem: string) {
		const { apiKey, apiToken } = this.settings;
		const url = `https://api.trello.com/1/cards/${cardId}/checkItem/${idCheckItem}?key=${apiKey}&token=${apiToken}`;
		await requestUrl({
			url: url,
			method: 'DELETE',
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

	parseObsidianContent(
		content: string,
		lists: TrelloList[],
		defaultListId: string,
	): ParsedObsidian {
		const parsedCards: ObsParsedCard[] = [];
		const parsedLists: ObsParsedList[] = [];
		let currentListId = defaultListId;
		let currentCard: ObsParsedCard | null = null;
		const lines = content.split('\n');

		for (const line of lines) {
			const headerMatch = line.match(
				/^##\s+(.*?)(?:\s+<!-- listId:([a-zA-Z0-9]+) -->)?$/,
			);

			if (headerMatch) {
				const sectionTitle = (headerMatch[1] || '').trim();
				const listIdMatch = headerMatch[2];

				let matchedList: TrelloList | undefined;

				if (listIdMatch) {
					matchedList = lists.find((l) => l.id === listIdMatch);
				}

				if (!matchedList) {
					matchedList = lists.find(
						(l) =>
							l.name.trim().toLowerCase() ===
							sectionTitle.toLowerCase(),
					);
				}

				if (matchedList) {
					currentListId = matchedList.id;
					parsedLists.push({
						id: matchedList.id,
						name: sectionTitle,
					});
				} else {
					currentListId = defaultListId;
				}
				currentCard = null;
				continue;
			}

			const cardMatch = line.match(
				/^- \[(x|X| )\] (.*?)(?: <!-- id:([a-zA-Z0-9]+) -->)?$/,
			);
			if (cardMatch) {
				const isChecked = (cardMatch[1] || '').toLowerCase() === 'x';
				let rawStr = cardMatch[2] || '';
				const id = cardMatch[3];

				let startDate = '',
					dueDate = '';
				const startM = rawStr.match(/🛫 (\d{4}-\d{2}-\d{2})/);
				if (startM && startM[1]) {
					startDate = startM[1];
					rawStr = rawStr.replace(startM[0] || '', '');
				}
				const dueM = rawStr.match(/📅 (\d{4}-\d{2}-\d{2})/);
				if (dueM && dueM[1]) {
					dueDate = dueM[1];
					rawStr = rawStr.replace(dueM[0] || '', '');
				}

				const tags: string[] = [];
				const tagRegex = /#([^\s#]+)/g;
				let tagMatch;
				while ((tagMatch = tagRegex.exec(rawStr)) !== null) {
					if (tagMatch[1]) tags.push(tagMatch[1].toLowerCase());
				}
				rawStr = rawStr.replace(tagRegex, '');

				const members: string[] = [];
				const membersRegex = /👤\((.*?)\)/;
				const membersM = rawStr.match(membersRegex);
				if (membersM && membersM[1]) {
					membersM[1]
						.split(',')
						.forEach((m) =>
							members.push(m.trim().replace('@', '')),
						);
					rawStr = rawStr.replace(membersM[0] || '', '');
				}

				rawStr = rawStr.replace(/\s+/g, ' ').trim();

				currentCard = {
					id,
					listId: currentListId,
					isChecked,
					name: rawStr,
					startDate,
					dueDate,
					tags,
					members,
					desc: '',
					checkItems: [],
				};
				parsedCards.push(currentCard);
				continue;
			}

			if (currentCard) {
				if (line.startsWith(' {2}> ') || line.startsWith('  > ')) {
					currentCard.desc +=
						(currentCard.desc ? '\n' : '') + line.substring(4);
				} else if (line.match(/^ {2}- \[(x|X| )\] /)) {
					const cm = line.match(/^ {2}- \[(x|X| )\] (.*)/);
					if (cm && cm[2]) {
						currentCard.checkItems.push({
							checked: (cm[1] || '').toLowerCase() === 'x',
							name: cm[2].trim(),
						});
					}
				} else if (line.trim() !== '') {
					currentCard = null;
				}
			}
		}
		return { cards: parsedCards, lists: parsedLists };
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
			const boardMembers = await this.getBoardMembers(boardId);
			const memberMap = new Map<string, string>();
			for (const m of boardMembers)
				memberMap.set(m.username.toLowerCase(), m.id);

			const lists = await this.getBoardLists(boardId);
			let cards = await this.getBoardCards(boardId);
			const defaultFallbackListId = lists[0]?.id || '';

			let existingContent = '';
			let extraUserContent = '';

			const existingFile = this.getTargetFile(mapping.targetNotePath);
			let knownCardIds =
				this.knownCardIdsByMapping.get(mappingKey) || new Set<string>();

			if (existingFile) {
				existingContent = await this.app.vault.read(existingFile);

				const endMarker = '<!-- END TRELLO SYNC -->';
				if (existingContent.includes(endMarker)) {
					extraUserContent = (
						existingContent.split(endMarker)[1] || ''
					).replace(/^[\r\n]+/, '');
					existingContent = existingContent.split(endMarker)[0] || '';
				}

				const parsedData = this.parseObsidianContent(
					existingContent,
					lists,
					defaultFallbackListId,
				);
				const parsedCards = parsedData.cards;

				// --- SYNC LIST NAMES (Two-Way) ---
				if (this.settings.syncListNames) {
					for (const obsList of parsedData.lists) {
						if (obsList.id) {
							const tList = lists.find(
								(l) => l.id === obsList.id,
							);
							if (tList) {
								const statusKey = `${mappingKey}::list::${obsList.id}`;
								const trelloName = tList.name;
								const wasName =
									this.lastKnownListName.get(statusKey) ??
									trelloName;

								if (obsList.name !== trelloName) {
									if (
										obsList.name !== wasName &&
										trelloName === wasName
									) {
										// Changed in Obsidian -> Update Trello
										try {
											await this.updateTrelloList(
												obsList.id,
												obsList.name,
											);
											tList.name = obsList.name;
											this.lastKnownListName.set(
												statusKey,
												obsList.name,
											);
										} catch (err) {
											console.debug(
												'Failed to rename Trello list',
												err,
											);
										}
									} else {
										// Changed in Trello -> Trello wins
										this.lastKnownListName.set(
											statusKey,
											trelloName,
										);
									}
								} else {
									this.lastKnownListName.set(
										statusKey,
										trelloName,
									);
								}
							}
						}
					}
				}

				const presentCardIds = new Set<string>();
				parsedCards.forEach((c) => {
					if (c.id) presentCardIds.add(c.id);
				});

				if (knownCardIds.size > 0) {
					for (const knownId of knownCardIds) {
						if (!presentCardIds.has(knownId)) {
							try {
								if (deleteBehavior === 'delete')
									await this.deleteTrelloCard(knownId);
								else await this.archiveTrelloCard(knownId);
								cards = cards.filter((c) => c.id !== knownId);
							} catch (err) {
								console.debug(
									`Failed to remove/archive card ${knownId} in Trello.`,
									err,
								);
							}
						}
					}
				}
				knownCardIds = presentCardIds;

				for (const obsCard of parsedCards) {
					const obsCardId = obsCard.id;

					if (!obsCardId) {
						try {
							const newCard = await this.createTrelloCard(
								obsCard.name,
								obsCard.listId,
								obsCard.startDate,
								obsCard.dueDate,
								obsCard.desc,
							);

							if (obsCard.tags.length > 0) {
								await this.syncCardLabels(
									boardId,
									newCard.id,
									obsCard.tags,
									boardLabels,
								);
							}

							const memIds = obsCard.members
								.map((u) => memberMap.get(u.toLowerCase()))
								.filter((id): id is string => !!id);
							if (memIds.length > 0) {
								await this.updateTrelloCard(newCard.id, {
									idMembers: memIds,
								});
								newCard.members = memIds
									.map((id) =>
										boardMembers.find((m) => m.id === id),
									)
									.filter((m): m is TrelloMember => !!m);
							}

							if (obsCard.checkItems.length > 0) {
								const cl = await this.createChecklist(
									newCard.id,
									'Checklist',
								);
								newCard.checklists = [cl];
								for (const item of obsCard.checkItems) {
									const ti = await this.createChecklistItem(
										cl.id,
										item.name,
									);
									if (item.checked) {
										await this.updateChecklistItemState(
											newCard.id,
											ti.id,
											'complete',
										);
										ti.state = 'complete';
									}
									cl.checkItems.push(ti);
								}
							}

							if (obsCard.isChecked) {
								let targetList: string | undefined = undefined;
								const automations = mapping.automations;
								if (mapping.enableMoveOnCheck && automations) {
									const rule = automations.find(
										(a) =>
											a.sourceListId === obsCard.listId,
									);
									if (rule) targetList = rule.targetListId;
								}
								await this.updateTrelloCard(newCard.id, {
									isComplete: true,
									targetListId: targetList,
								});
								newCard.dueComplete = true;
								if (targetList) newCard.idList = targetList;
							}

							cards.push(newCard);
							knownCardIds.add(newCard.id);
						} catch (err) {
							console.debug(
								`Failed to create card "${obsCard.name}" in Trello.`,
								err,
							);
						}
					} else {
						const currentCard = cards.find(
							(c) => c.id === obsCardId,
						);
						if (!currentCard) continue;

						const statusKey = `${mappingKey}::${obsCardId}`;
						const updateProps: {
							isComplete?: boolean;
							targetListId?: string;
							start?: string;
							due?: string;
							idLabels?: string[];
							desc?: string;
							idMembers?: string[];
							name?: string;
						} = {};

						const trelloName = currentCard.name || '';
						const wasName =
							this.lastKnownCardName.get(statusKey) ?? trelloName;
						if (obsCard.name !== trelloName) {
							if (
								obsCard.name !== wasName &&
								trelloName === wasName
							) {
								updateProps.name = obsCard.name;
								this.lastKnownCardName.set(
									statusKey,
									obsCard.name,
								);
							} else {
								this.lastKnownCardName.set(
									statusKey,
									trelloName,
								);
							}
						} else {
							this.lastKnownCardName.set(statusKey, trelloName);
						}

						const trelloListId = currentCard.idList;
						const wasListId =
							this.lastKnownCardList.get(statusKey) ??
							trelloListId;
						if (obsCard.listId !== trelloListId) {
							if (
								obsCard.listId !== wasListId &&
								trelloListId === wasListId
							) {
								updateProps.targetListId = obsCard.listId;
								this.lastKnownCardList.set(
									statusKey,
									obsCard.listId,
								);
							} else {
								this.lastKnownCardList.set(
									statusKey,
									trelloListId,
								);
							}
						} else {
							this.lastKnownCardList.set(statusKey, trelloListId);
						}

						const trelloStart = currentCard.start
							? currentCard.start.substring(0, 10)
							: '';
						const trelloDue = currentCard.due
							? currentCard.due.substring(0, 10)
							: '';
						const lastDates = this.lastKnownCardDates.get(
							statusKey,
						) || { start: trelloStart, due: trelloDue };

						if (obsCard.startDate !== lastDates.start)
							updateProps.start = obsCard.startDate;
						if (obsCard.dueDate !== lastDates.due)
							updateProps.due = obsCard.dueDate;

						const trelloTags = (currentCard.labels || [])
							.filter((l) => l.name)
							.map((l) =>
								(l.name || '')
									.toLowerCase()
									.replace(/\s+/g, '-'),
							);
						const lastTags =
							this.lastKnownCardLabels.get(statusKey) ||
							trelloTags;
						const obsidianTagsChanged =
							JSON.stringify(obsCard.tags.sort()) !==
							JSON.stringify(lastTags.sort());

						if (obsidianTagsChanged) {
							try {
								currentCard.idLabels =
									await this.syncCardLabels(
										boardId,
										obsCardId,
										obsCard.tags,
										boardLabels,
									);
								this.lastKnownCardLabels.set(
									statusKey,
									obsCard.tags,
								);
							} catch (err) {
								console.debug('Failed to sync tags:', err);
							}
						} else {
							this.lastKnownCardLabels.set(statusKey, trelloTags);
						}

						const isDoneInTrello = !!currentCard.dueComplete;
						const wasChecked =
							this.lastKnownCardStatus.get(statusKey);

						if (obsCard.isChecked !== isDoneInTrello) {
							if (
								wasChecked !== undefined &&
								obsCard.isChecked !== wasChecked &&
								isDoneInTrello === wasChecked
							) {
								updateProps.isComplete = obsCard.isChecked;
								const localAutomations = mapping.automations;
								if (
									mapping.enableMoveOnCheck &&
									localAutomations
								) {
									const rule = localAutomations.find((a) =>
										obsCard.isChecked
											? a.sourceListId ===
												currentCard.idList
											: a.targetListId ===
												currentCard.idList,
									);
									if (rule)
										updateProps.targetListId =
											obsCard.isChecked
												? rule.targetListId
												: rule.sourceListId;
								}
							} else {
								this.lastKnownCardStatus.set(
									statusKey,
									isDoneInTrello,
								);
							}
						}

						const trelloDesc = currentCard.desc || '';
						const wasDesc =
							this.lastKnownCardDesc.get(statusKey) ?? trelloDesc;
						if (obsCard.desc !== trelloDesc) {
							if (
								obsCard.desc !== wasDesc &&
								trelloDesc === wasDesc
							) {
								updateProps.desc = obsCard.desc;
								this.lastKnownCardDesc.set(
									statusKey,
									obsCard.desc,
								);
							} else {
								this.lastKnownCardDesc.set(
									statusKey,
									trelloDesc,
								);
							}
						} else {
							this.lastKnownCardDesc.set(statusKey, trelloDesc);
						}

						const obsMembersIds = obsCard.members
							.map((u) => memberMap.get(u.toLowerCase()))
							.filter((id): id is string => !!id);
						const trelloMembersIds = (
							currentCard.members || []
						).map((m) => m.id);
						const wasMembersIds =
							this.lastKnownCardMembers.get(statusKey) ??
							trelloMembersIds;

						if (
							obsMembersIds.sort().join(',') !==
							trelloMembersIds.sort().join(',')
						) {
							if (
								obsMembersIds.sort().join(',') !==
									wasMembersIds.sort().join(',') &&
								trelloMembersIds.sort().join(',') ===
									wasMembersIds.sort().join(',')
							) {
								updateProps.idMembers = obsMembersIds;
								this.lastKnownCardMembers.set(
									statusKey,
									obsMembersIds,
								);
							} else {
								this.lastKnownCardMembers.set(
									statusKey,
									trelloMembersIds,
								);
							}
						} else {
							this.lastKnownCardMembers.set(
								statusKey,
								trelloMembersIds,
							);
						}

						if (Object.keys(updateProps).length > 0) {
							try {
								await this.updateTrelloCard(
									obsCardId,
									updateProps,
								);

								if (updateProps.isComplete !== undefined) {
									currentCard.dueComplete =
										updateProps.isComplete;
									this.lastKnownCardStatus.set(
										statusKey,
										updateProps.isComplete,
									);
								}
								if (updateProps.targetListId) {
									currentCard.idList =
										updateProps.targetListId;
								}
								if (updateProps.start !== undefined) {
									currentCard.start = updateProps.start
										? `${updateProps.start}T00:00:00.000Z`
										: undefined;
									lastDates.start = updateProps.start || '';
								}
								if (updateProps.due !== undefined) {
									currentCard.due = updateProps.due
										? `${updateProps.due}T00:00:00.000Z`
										: undefined;
									lastDates.due = updateProps.due || '';
								}
								if (updateProps.desc !== undefined) {
									currentCard.desc = updateProps.desc;
								}
								if (updateProps.idMembers !== undefined) {
									currentCard.members = updateProps.idMembers
										.map((id) =>
											boardMembers.find(
												(m) => m.id === id,
											),
										)
										.filter((m): m is TrelloMember => !!m);
								}
								if (updateProps.name !== undefined) {
									currentCard.name = updateProps.name;
								}
								this.lastKnownCardDates.set(
									statusKey,
									lastDates,
								);
							} catch (err) {
								console.debug(
									'Failed to update card properties:',
									err,
								);
							}
						} else {
							this.lastKnownCardDates.set(statusKey, {
								start: trelloStart,
								due: trelloDue,
							});
						}

						let trelloChecklist =
							currentCard.checklists &&
							currentCard.checklists.length > 0
								? currentCard.checklists[0]
								: null;

						const matchedTrelloItemIds = new Set<string>();

						for (const obsItem of obsCard.checkItems) {
							const itemKey = `${statusKey}::checklist::${obsItem.name}`;
							let trelloItem =
								trelloChecklist && trelloChecklist.checkItems
									? trelloChecklist.checkItems.find(
											(i) => i.name === obsItem.name,
										)
									: null;
							const obsStateStr = obsItem.checked
								? 'complete'
								: 'incomplete';

							if (!trelloItem) {
								if (!trelloChecklist) {
									trelloChecklist =
										await this.createChecklist(
											obsCardId,
											'Checklist',
										);
									if (!currentCard.checklists)
										currentCard.checklists = [];
									currentCard.checklists.push(
										trelloChecklist,
									);
								}

								if (trelloChecklist) {
									try {
										trelloItem =
											await this.createChecklistItem(
												trelloChecklist.id,
												obsItem.name,
											);
										if (obsItem.checked) {
											await this.updateChecklistItemState(
												obsCardId,
												trelloItem.id,
												'complete',
											);
											trelloItem.state = 'complete';
										}
										this.lastKnownChecklistState.set(
											itemKey,
											obsItem.checked,
										);
										if (!trelloChecklist.checkItems)
											trelloChecklist.checkItems = [];
										trelloChecklist.checkItems.push(
											trelloItem,
										);
										matchedTrelloItemIds.add(trelloItem.id);
									} catch (err) {
										console.debug(
											'Failed to create checklist item:',
											err,
										);
									}
								}
							} else {
								matchedTrelloItemIds.add(trelloItem.id);
								const trelloStateStr = trelloItem.state;
								const wasStateStr =
									this.lastKnownChecklistState.has(itemKey)
										? this.lastKnownChecklistState.get(
												itemKey,
											)
											? 'complete'
											: 'incomplete'
										: trelloStateStr;

								if (obsStateStr !== trelloStateStr) {
									if (
										obsStateStr !== wasStateStr &&
										trelloStateStr === wasStateStr
									) {
										await this.updateChecklistItemState(
											obsCardId,
											trelloItem.id,
											obsStateStr,
										);
										trelloItem.state = obsStateStr;
										this.lastKnownChecklistState.set(
											itemKey,
											obsItem.checked,
										);
									} else {
										this.lastKnownChecklistState.set(
											itemKey,
											trelloStateStr === 'complete',
										);
									}
								} else {
									this.lastKnownChecklistState.set(
										itemKey,
										trelloStateStr === 'complete',
									);
								}
							}
						}

						if (trelloChecklist && trelloChecklist.checkItems) {
							const itemsToDelete =
								trelloChecklist.checkItems.filter(
									(i) => !matchedTrelloItemIds.has(i.id),
								);
							for (const tItem of itemsToDelete) {
								try {
									await this.deleteChecklistItem(
										obsCardId,
										tItem.id,
									);
									this.lastKnownChecklistState.delete(
										`${statusKey}::checklist::${tItem.name}`,
									);
								} catch (err) {
									console.debug(
										'Failed to delete checklist item:',
										err,
									);
								}
							}
							trelloChecklist.checkItems =
								trelloChecklist.checkItems.filter((i) =>
									matchedTrelloItemIds.has(i.id),
								);
						}
					}
				}
			}

			const enforceAutomations = mapping.automations;
			if (mapping.enableMoveOnCheck && enforceAutomations) {
				for (const card of cards) {
					let newTargetListId: string | undefined = undefined;
					const isDone = !!card.dueComplete;

					if (isDone) {
						const rule = enforceAutomations.find(
							(a) => a.sourceListId === card.idList,
						);
						if (rule) newTargetListId = rule.targetListId;
					} else {
						const rule = enforceAutomations.find(
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
						} catch (err) {
							console.debug('Failed automation update:', err);
						}
					}
				}
			}

			let trelloSection = `# ${boardName}\n\n`;
			trelloSection += `*Synced from Trello on ${new Date().toLocaleString()}*\n\n`;

			if (this.settings.showBoardMembers) {
				try {
					const boardMembersInfo =
						await this.getBoardMembers(boardId);
					if (boardMembersInfo && boardMembersInfo.length > 0) {
						trelloSection += `**👥Board Members:** ${boardMembersInfo.map((m) => `@${m.username}`).join(', ')}\n\n`;
					}
				} catch (err) {
					console.debug(
						'Failed to fetch members for section header:',
						err,
					);
				}
			}

			trelloSection += `---\n\n`;

			for (const list of lists) {
				const listIdComment = this.settings.syncListNames
					? ` <!-- listId:${list.id} -->`
					: '';
				trelloSection += `## ${list.name}${listIdComment}\n\n`;
				this.lastKnownListName.set(
					`${mappingKey}::list::${list.id}`,
					list.name,
				);

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
									`#${(l.name || '').toLowerCase().replace(/\s+/g, '-')}`,
							);
						if (tTags.length > 0) tagsStr = ` ${tTags.join(' ')}`;

						let membersStr = '';
						if (
							this.settings.syncCardMembers &&
							card.members &&
							card.members.length > 0
						) {
							membersStr = ` 👤(${card.members.map((m) => `@${m.username}`).join(', ')})`;
						}

						trelloSection += `- [${isChecked}] ${card.name}${dateStr}${tagsStr}${membersStr} <!-- id:${card.id} -->\n`;

						knownCardIds.add(card.id);
						const statusKey = `${mappingKey}::${card.id}`;
						this.lastKnownCardStatus.set(
							statusKey,
							!!card.dueComplete,
						);
						this.lastKnownCardDates.set(statusKey, {
							start: tStart,
							due: tDue,
						});
						this.lastKnownCardLabels.set(
							statusKey,
							tTags.map((t) => t.replace('#', '')),
						);
						this.lastKnownCardDesc.set(statusKey, card.desc || '');
						this.lastKnownCardMembers.set(
							statusKey,
							(card.members || []).map((m) => m.id),
						);
						this.lastKnownCardName.set(statusKey, card.name);
						this.lastKnownCardList.set(statusKey, card.idList);

						if (
							this.settings.syncCardDescription &&
							card.desc &&
							card.desc.trim() !== ''
						) {
							const indentedDesc = card.desc
								.split('\n')
								.map((line) => `  > ${line}`)
								.join('\n');
							trelloSection += `${indentedDesc}\n`;
						}

						if (
							this.settings.syncCardChecklists &&
							card.checklists &&
							card.checklists.length > 0
						) {
							for (const cl of card.checklists) {
								if (cl.checkItems && cl.checkItems.length > 0) {
									for (const item of cl.checkItems) {
										const itemChecked =
											item.state === 'complete'
												? 'x'
												: ' ';
										trelloSection += ` {2}- [${itemChecked}] ${item.name}\n`;
										this.lastKnownChecklistState.set(
											`${statusKey}::checklist::${item.name}`,
											item.state === 'complete',
										);
									}
								}
							}
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

			if (existingFile) {
				if (
					existingContent.trim() !==
					fullMarkdownContent
						.replace(`\n\n${extraUserContent}`, '')
						.trim()
				) {
					await this.app.vault.modify(
						existingFile,
						fullMarkdownContent,
					);
				}
			} else {
				const fileName = `Trello - ${boardName}.md`;
				const fallback = this.app.vault.getAbstractFileByPath(fileName);
				if (fallback instanceof TFile) {
					await this.app.vault.modify(fallback, fullMarkdownContent);
				} else {
					await this.app.vault.create(fileName, fullMarkdownContent);
				}
				mapping.targetNotePath = fileName;
				await this.saveSettings();
			}
		} catch (error) {
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
			for (const card of allActiveCards)
				trelloCardNamesMap.set(card.name.trim().toLowerCase(), card);

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
				if (
					allFileNames.has(normalizedCardName) &&
					!obsidianItemsMap.has(normalizedCardName)
				) {
					try {
						if (deleteBehavior === 'delete')
							await this.deleteTrelloCard(card.id);
						else await this.archiveTrelloCard(card.id);
					} catch (err) {
						console.debug(
							'Failed removing card from folder tracking:',
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
					} catch (err) {
						console.debug(
							'Failed adding card to folder tracking:',
							err,
						);
					}
				}
			}
		} catch (error) {
			console.error('Folder Sync Error:', error);
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
				for (const card of allActiveCards)
					cardNamesMap.set(card.name.trim().toLowerCase(), card);

				const taggedItemsMap = new Map<string, string>();
				for (const file of taggedFiles)
					taggedItemsMap.set(
						file.basename.trim().toLowerCase(),
						file.basename,
					);

				for (const card of listCards) {
					const normName = card.name.trim().toLowerCase();
					if (
						allFileNames.has(normName) &&
						!taggedItemsMap.has(normName)
					) {
						try {
							if (deleteBehavior === 'delete')
								await this.deleteTrelloCard(card.id);
							else await this.archiveTrelloCard(card.id);
						} catch (err) {
							console.debug(
								'Failed to archive/delete tagged card:',
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
						} catch (err) {
							console.debug('Failed to create tagged card:', err);
						}
					}
				}
			} catch (err) {
				console.debug('Failed running tag automation check:', err);
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
	cardDescription: string = '';
	checklistText: string = '';
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

		this.boards = await this.plugin.getTrelloBoards().catch((err) => {
			console.debug(err);
			return [];
		});

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
						.catch((err) => {
							console.debug(err);
							return [];
						});
					this.renderListDropdown();
				})();
			});
		});

		this.listDropdownEl = contentEl.createDiv();
		this.renderListDropdown();

		new Setting(contentEl)
			.setName('Card Name')
			.addText((text) => text.onChange((val) => (this.cardName = val)));

		new Setting(contentEl).setName('Description').addTextArea((text) => {
			text.setPlaceholder('Enter card description...');
			text.onChange((val) => (this.cardDescription = val));
			text.inputEl.rows = 3;
			text.inputEl.cols = 40;
		});

		new Setting(contentEl)
			.setName('Checklist Items')
			.setDesc('Enter checklist items (one per line)')
			.addTextArea((text) => {
				text.setPlaceholder('Task 1\nTask 2\nTask 3');
				text.onChange((val) => (this.checklistText = val));
				text.inputEl.rows = 4;
				text.inputEl.cols = 40;
			});

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
								this.cardDescription,
							);
							if (this.selectedTag && this.selectedBoardId) {
								const boardLabels =
									await this.plugin.getBoardLabels(
										this.selectedBoardId,
									);
								const cleanTag = this.selectedTag
									.replace('#', '')
									.trim();
								if (cleanTag)
									await this.plugin.syncCardLabels(
										this.selectedBoardId,
										newCard.id,
										[cleanTag],
										boardLabels,
									);
							}
							if (
								this.checklistText &&
								this.checklistText.trim() !== ''
							) {
								const items = this.checklistText
									.split('\n')
									.filter((i) => i.trim() !== '');
								if (items.length > 0) {
									const cl =
										await this.plugin.createChecklist(
											newCard.id,
											'Checklist',
										);
									for (const item of items) {
										await this.plugin.createChecklistItem(
											cl.id,
											item.trim(),
										);
									}
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
