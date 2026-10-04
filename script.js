let isOffline = !navigator.onLine;
let savedPlans = [
    // Pre-loaded failed sync to demonstrate FR-05 requirement[cite: 14, 18]
    { id: 1, title: "Previous Failed Session", status: "Failed Sync", hasConflict: true }
];

const activities = [
    { title: "Paper Bridge Challenge", level: "Beginner", duration: "45 min" },
    { title: "Vinegar & Baking Soda", level: "Beginner", duration: "30 min" },
    { title: "Seed Germination Study", level: "Intermediate", duration: "60 min" },
    { title: "Pendulum Patterns", level: "Intermediate", duration: "45 min" },
    { title: "Advanced Robotics", level: "Advance", duration: "90 min" }
];

// Core Network Detection Logic
function updateNetworkUI(offlineState) {
    isOffline = offlineState;
    const banner = document.getElementById('offline-banner');
    const statusText = document.getElementById('network-status-text');
    
    if (isOffline) {
        banner.classList.add('is-offline');
        banner.innerHTML = "<strong>Offline</strong><br><small>Data will sync when connected.</small>";
        statusText.innerText = "Offline";
    } else {
        banner.classList.remove('is-offline');
        banner.innerHTML = "<strong>Online</strong><br><small>Tap here to test offline mode.</small>";
        statusText.innerText = "Online";
        syncPendingPlans(); 
    }
}

window.addEventListener('offline', () => updateNetworkUI(true));
window.addEventListener('online', () => updateNetworkUI(false));
window.addEventListener('DOMContentLoaded', () => {
    updateNetworkUI(!navigator.onLine);
    showScreen('screen-home');
});

function toggleOfflineMode() {
    updateNetworkUI(!isOffline);
}

// Screen Navigation
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active-screen'));
    document.getElementById(screenId).classList.add('active-screen');
    
    if(screenId === 'screen-activities') filterActivities('All');
    if(screenId === 'screen-saved') renderSavedPlans();
}

// Activity Filtering[cite: 13, 18]
function filterActivities(level) {
    const list = document.getElementById('activity-list');
    list.innerHTML = '';
    
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.innerText === level);
    });

    const filtered = level === 'All' ? activities : activities.filter(a => a.level === level);
    
    filtered.forEach(act => {
        list.innerHTML += `
            <div class="card">
                <strong>${act.title}</strong><br>
                <small>${act.level} · ${act.duration}</small><br>
                <button class="btn btn-small" onclick="alert('Saved ${act.title} for offline use!')">Save Offline</button>
            </div>
        `;
    });
}

// Save Plan Workflow[cite: 14, 18]
function savePlan() {
    const title = document.getElementById('plan-title').value || "Untitled Plan";
    const status = isOffline ? "Pending Sync" : "Synced";
    
    savedPlans.push({ id: Date.now(), title: title, status: status, hasConflict: false });
    
    const msg = document.getElementById('save-status-msg');
    msg.style.display = 'block';
    msg.innerText = isOffline ? "Saved locally. Will sync when online." : "Plan saved and synced!";
    
    setTimeout(() => {
        msg.style.display = 'none';
        document.querySelectorAll('#screen-create-plan input').forEach(input => input.value = '');
        showScreen('screen-saved');
    }, 1500);
}

// Render Saved Plans & Sync Status[cite: 14, 18]
function renderSavedPlans() {
    const list = document.getElementById('saved-plans-list');
    list.innerHTML = '';
    
    if (savedPlans.length === 0) {
        list.innerHTML = '<p style="text-align:center; color:#666;">No plans created yet.</p>';
        return;
    }

    savedPlans.forEach(plan => {
        let badgeClass = 'status-pending';
        if (plan.status === 'Synced') badgeClass = 'status-synced';
        if (plan.status === 'Failed Sync') badgeClass = 'status-failed';
        
        let extraHTML = '';
        if (plan.status === 'Failed Sync') {
            extraHTML = `
                <div style="margin-top:10px;">
                    <small style="color:red;">Conflict: Server has a newer version.</small><br>
                    <button class="btn btn-small" onclick="resolveConflict(${plan.id}, 'server')">Use Server</button>
                    <button class="btn btn-small" onclick="resolveConflict(${plan.id}, 'local')">Keep Local (Retry)</button>
                </div>
            `;
        }

        list.innerHTML += `
            <div class="card">
                <strong>${plan.title}</strong><br>
                <span class="status-badge ${badgeClass}">${plan.status}</span>
                ${extraHTML}
            </div>
        `;
    });
}

function resolveConflict(id, choice) {
    const plan = savedPlans.find(p => p.id === id);
    if (plan) {
        plan.status = 'Synced';
        plan.hasConflict = false;
        plan.title = choice === 'server' ? plan.title + " (Server Version)" : plan.title + " (Local Version)";
        renderSavedPlans();
        alert(`Conflict resolved using ${choice} version.`);
    }
}

function syncPendingPlans() {
    let syncedCount = 0;
    savedPlans.forEach(plan => {
        if (plan.status === 'Pending Sync') {
            plan.status = 'Synced';
            syncedCount++;
        }
    });
    
    if (syncedCount > 0 && document.getElementById('screen-saved').classList.contains('active-screen')) {
        renderSavedPlans();
        alert(`${syncedCount} plan(s) successfully synced to the server!`);
    }
}