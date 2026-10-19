// Drag and Drop - handles folder drag-and-drop to open/create projects
import { electronAPI } from './core/platform.js';

export class DragDrop {
  constructor(app) {
    this.app = app;
  }

  setup() {
    let dropOverlay = null;

    // Create drop overlay element (hidden by default)
    const createDropOverlay = () => {
      if (dropOverlay) return dropOverlay;
      dropOverlay = document.createElement('div');
      dropOverlay.className = 'drop-overlay hidden';
      dropOverlay.innerHTML = `
        <div class="drop-overlay-content">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
            <line x1="12" y1="11" x2="12" y2="17"/>
            <line x1="9" y1="14" x2="15" y2="14"/>
          </svg>
          <span>Drop folder to open project</span>
        </div>
      `;
      document.body.appendChild(dropOverlay);
      return dropOverlay;
    };

    // Track drag enter/leave for nested elements
    let dragCounter = 0;

    document.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;

      // Only show overlay if dragging files/folders
      if (e.dataTransfer?.types?.includes('Files')) {
        const overlay = createDropOverlay();
        overlay.classList.remove('hidden');
      }
    });

    document.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;

      if (dragCounter === 0 && dropOverlay) {
        dropOverlay.classList.add('hidden');
      }
    });

    document.addEventListener('dragover', (e) => {
      e.preventDefault();
      // Required to allow drop
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
    });

    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;

      if (dropOverlay) {
        dropOverlay.classList.add('hidden');
      }

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      // Get the first dropped item's path
      const droppedPath = files[0].path;
      if (!droppedPath) return;

      // Check if it's a directory
      const isDir = await electronAPI().isDirectory(droppedPath);
      if (!isDir) {
        console.log('[DROP] Dropped item is not a directory:', droppedPath);
        return;
      }

      console.log('[DROP] Folder dropped:', droppedPath);
      await this.handleDroppedFolder(droppedPath);
    });
  }

  // Handle a dropped folder - find existing project or create new one
  async handleDroppedFolder(folderPath) {
    // Normalize the path for comparison (handle Windows backslashes)
    const normalizePath = (p) => p.toLowerCase().replace(/\\/g, '/');
    const normalizedDropped = normalizePath(folderPath);

    // Search existing projects for matching workingDir
    for (const project of this.app.projects) {
      if (project.workingDir) {
        const normalizedExisting = normalizePath(project.workingDir);
        if (normalizedExisting === normalizedDropped) {
          console.log('[DROP] Found existing project:', project.id, project.name);
          // Select this project
          this.app.projectManager.setActive(project.id);
          return;
        }
      }
    }

    // No existing project found - create a new one with this folder
    console.log('[DROP] Creating new project for folder:', folderPath);

    // Use folder name as project name
    const folderName = folderPath.split(/[/\\]/).pop() || 'New Project';

    const project = {
      id: 'project-' + Date.now(),
      name: folderName,
      chats: [],
      expanded: true,
      createdAt: Date.now(),
      workingDir: folderPath
    };

    this.app.projects.push(project);
    this.app.projectManager.markProjectDirty(project.id, 'create', project);
    this.app.projectManager.save();
    this.app.activeProjectId = project.id;
    this.app.projectDir = folderPath;
    this.app.updateProjectDirDisplay();
    this.app.projectManager.renderList();

    // Start editing the project name
    setTimeout(() => this.app.projectManager.startEditingName(project.id), 50);
  }
}
