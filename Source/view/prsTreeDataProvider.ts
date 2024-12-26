/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuthProvider } from '../common/authentication';
import { commands, contexts } from '../common/executeCommands';
import { Disposable } from '../common/lifecycle';
import { FILE_LIST_LAYOUT, PR_SETTINGS_NAMESPACE, QUERIES, REMOTES } from '../common/settingKeys';
import { ITelemetry } from '../common/telemetry';
import { EXTENSION_ID } from '../constants';
import { CredentialStore } from '../github/credentials';
import { FolderRepositoryManager, ReposManagerState } from '../github/folderRepositoryManager';
import { PRType } from '../github/interface';
import { NotificationProvider } from '../github/notifications';
import { PullRequestModel } from '../github/pullRequestModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { findDotComAndEnterpriseRemotes } from '../github/utils';
import { PRStatusDecorationProvider } from './prStatusDecorationProvider';
import { PrsTreeModel } from './prsTreeModel';
import { ReviewModel } from './reviewModel';
import { CategoryTreeNode, PRCategoryActionNode, PRCategoryActionType } from './treeNodes/categoryNode';
import { InMemFileChangeNode } from './treeNodes/fileChangeNode';
import { BaseTreeNode, TreeNode } from './treeNodes/treeNode';
import { TreeUtils } from './treeNodes/treeUtils';
import { WorkspaceFolderNode } from './treeNodes/workspaceFolderNode';

export class PullRequestsTreeDataProvider extends Disposable implements vscode.TreeDataProvider<TreeNode>, BaseTreeNode {
	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	get onDidChange(): vscode.Event<vscode.Uri> {
		return this._onDidChange.event;
	}
	private _children: WorkspaceFolderNode[] | CategoryTreeNode[];
	get children() {
		return this._children;
	}
	private _view: vscode.TreeView<TreeNode>;
	private _initialized: boolean = false;
	public notificationProvider: NotificationProvider;
	public readonly prsTreeModel: PrsTreeModel;

	get view(): vscode.TreeView<TreeNode> {
		return this._view;
	}

	constructor(private readonly _telemetry: ITelemetry, private readonly _context: vscode.ExtensionContext, private readonly _reposManager: RepositoriesManager) {
		super();
		this.prsTreeModel = this._register(new PrsTreeModel(this._telemetry, this._reposManager, _context));
		this._register(this.prsTreeModel.onDidChangeData(folderManager => folderManager ? this.refreshRepo(folderManager) : this.refresh()));
		this._register(new PRStatusDecorationProvider(this.prsTreeModel));
		this._register(vscode.commands.registerCommand('pr.refreshList', _ => {
			this.refresh(undefined, true);
		}));

		this._register(vscode.commands.registerCommand('pr.loadMore', (node: CategoryTreeNode) => {
			node.fetchNextPage = true;
			this._onDidChangeTreeData.fire(node);
		}));

		this._view = this._register(vscode.window.createTreeView('pr:github', {
			treeDataProvider: this,
			showCollapseAll: true,
		}));

		this._children = [];

		this._register(vscode.commands.registerCommand('pr.configurePRViewlet', async () => {
			const configuration = await vscode.window.showQuickPick([
				'Configure Remotes...',
				'Configure Queries...'
			]);

			switch (configuration) {
				case 'Configure Queries...':
					return vscode.commands.executeCommand(
						'workbench.action.openSettings',
						`@ext:${EXTENSION_ID} queries`,
					);
				case 'Configure Remotes...':
					return vscode.commands.executeCommand(
						'workbench.action.openSettings',
						`@ext:${EXTENSION_ID} remotes`,
					);
				default:
					return;
			}
		}));

		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${FILE_LIST_LAYOUT}`)) {
				this._onDidChangeTreeData.fire();
			}
		}));

		this._register(this._view.onDidChangeCheckboxState(TreeUtils.processCheckboxUpdates));

		this._register(this._view.onDidExpandElement(expanded => {
			this.prsTreeModel.updateExpandedQueries(expanded.element, true);
		}));
		this._register(this._view.onDidCollapseElement(collapsed => {
			this.prsTreeModel.updateExpandedQueries(collapsed.element, false);
		}));
	}

	public async expandPullRequest(pullRequest: PullRequestModel) {
		if (this._children.length === 0) {
			await this.getChildren();
		}
		for (const child of this._children) {
			if (child instanceof WorkspaceFolderNode) {
				if (await child.expandPullRequest(pullRequest)) {
					return;
				}
			} else if (child.type === PRType.All) {
				if (await child.expandPullRequest(pullRequest)) {
					return;
				}
			}
		}
	}

	async reveal(element: TreeNode, options?: { select?: boolean, focus?: boolean, expand?: boolean }): Promise<void> {
		return this._view.reveal(element, options);
	}

	initialize(reviewModels: ReviewModel[], credentialStore: CredentialStore) {
		if (this._initialized) {
			throw new Error('Tree has already been initialized!');
		}

		this._initialized = true;
		this._register(
			this._reposManager.onDidChangeState(() => {
				this.refresh();
			}),
		);

		for (const model of reviewModels) {
			this._register(model.onDidChangeLocalFileChanges(_ => { this.refresh(); }));
		}

		this.notificationProvider = this._register(new NotificationProvider(this, credentialStore, this._reposManager));

		this.initializeCategories();
		this.refresh();
	}

	private async initializeCategories() {
		this._register(vscode.workspace.onDidChangeConfiguration(async e => {
			if (e.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${QUERIES}`)) {
				this.refresh();
			}
		}));
	}

	refresh(node?: TreeNode, reset?: boolean): void {
		if (reset) {
			this.prsTreeModel.clearCache();
		}
		return node ? this._onDidChangeTreeData.fire(node) : this._onDidChangeTreeData.fire();
	}

	private refreshRepo(manager: FolderRepositoryManager): void {
		if (this._children.length === 0) {
			return this.refresh();
		}
		if (this._children[0] instanceof WorkspaceFolderNode) {
			const children: WorkspaceFolderNode[] = this._children as WorkspaceFolderNode[];
			const node = children.find(node => node.folderManager === manager);
			if (node) {
				this._onDidChangeTreeData.fire(node);
				return;
			}
		}
	}

	getTreeItem(element: TreeNode): vscode.TreeItem | Promise<vscode.TreeItem> {
		return element.getTreeItem();
	}

	async resolveTreeItem(item: vscode.TreeItem, element: TreeNode): Promise<vscode.TreeItem> {
		if (element instanceof InMemFileChangeNode) {
			await element.resolve();
		}
		return element;
	}

	private async needsRemotes() {
		if (this._reposManager?.state === ReposManagerState.NeedsAuthentication) {
			return [];
		}

		const remotesSetting = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string[]>(REMOTES);
		let actions: PRCategoryActionNode[];
		if (remotesSetting) {
			actions = [
				new PRCategoryActionNode(this, PRCategoryActionType.NoMatchingRemotes),
				new PRCategoryActionNode(this, PRCategoryActionType.ConfigureRemotes),

			];
		} else {
			actions = [new PRCategoryActionNode(this, PRCategoryActionType.NoRemotes)];
		}

		const { enterpriseRemotes } = this._reposManager ? await findDotComAndEnterpriseRemotes(this._reposManager?.folderManagers) : { enterpriseRemotes: [] };
		if ((enterpriseRemotes.length > 0) && !this._reposManager?.credentialStore.isAuthenticated(AuthProvider.githubEnterprise)) {
			actions.push(new PRCategoryActionNode(this, PRCategoryActionType.LoginEnterprise));
		}

		return actions;
	}

	async cachedChildren(element?: WorkspaceFolderNode | CategoryTreeNode): Promise<TreeNode[]> {
		if (!element) {
			return this._children;
		}
		return element.cachedChildren();
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (!this._reposManager?.folderManagers.length) {
			return [];
		}

		if (this._reposManager.state === ReposManagerState.Initializing) {
			commands.setContext(contexts.LOADING_PRS_TREE, true);
			return [];
		}

		const remotes = await Promise.all(this._reposManager.folderManagers.map(manager => manager.getGitHubRemotes()));
		if ((this._reposManager.folderManagers.filter((_manager, index) => remotes[index].length > 0).length === 0)) {
			return this.needsRemotes();
		}

		const gitHubFolderManagers = this._reposManager.folderManagers.filter(manager => manager.gitHubRepositories.length > 0);
		if (!element) {
			if (this._children && this._children.length) {
				this._children.forEach(dispose => dispose.dispose());
			}

			let result: WorkspaceFolderNode[] | CategoryTreeNode[];
			if (gitHubFolderManagers.length === 1) {
				result = WorkspaceFolderNode.getCategoryTreeNodes(
					gitHubFolderManagers[0],
					this._telemetry,
					this,
					this.notificationProvider,
					this._context,
					this.prsTreeModel
				);
			} else {
				result = gitHubFolderManagers.map(
					folderManager =>
						new WorkspaceFolderNode(
							this,
							folderManager.repository.rootUri,
							folderManager,
							this._telemetry,
							this.notificationProvider,
							this._context,
							this.prsTreeModel
						),
				);
			}

			this._children = result;
			return result;
		}

		if (
			gitHubFolderManagers.filter(manager => manager.repository.state.remotes.length > 0).length === 0
		) {
			return Promise.resolve([new PRCategoryActionNode(this, PRCategoryActionType.Empty)]);
		}

		return element.getChildren();
	}

	async getParent(element: TreeNode) {
		return element.getParent();
	}
}
