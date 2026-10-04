let isOffline = false;

let savedPlans = [
    { id: 1, title: "Previous Failed Session", status: "Failed Sync" }
];

let activities = [
    { title: "Paper Bridge Challenge", level: "Beginner", duration: "45 min" },
    { title: "Vinegar & Baking Soda", level: "Beginner", duration: "30 min" },
    { title: "Seed Germination Study", level: "Intermediate", duration: "60 min" },
    { title: "Pendulum Patterns", level: "Intermediate", duration: "45 min" },
    { title: "Advanced Robotics", level: "Advance", duration: "90 min" }
];

// Helper function to show a friendly popup instead of annoying alerts
function showToast(message) {
    let toast = document.getElementById('toast-message');
    toast.innerText = message;
    toast.style.display = 'block';
    
    // Hide it again after 3 seconds
    setTimeout(function() {
        toast.style.display = 'none';
    }, 3000);
}

// 2. NETWORK CONNECTION LOGIC
function updateNetworkUI(offlineState) {
    isOffline = offlineState;
    let banner = document.getElementById('offline-banner');
    let statusText = document.getElementById('network-status-text');
    
    if (isOffline === true) {
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

window.addEventListener('offline', function() { updateNetworkUI(true); });
window.addEventListener('online', function() { updateNetworkUI(false); });
window.addEventListener('DOMContentLoaded', function() {
    if (navigator.onLine === false) {
        updateNetworkUI(true);
    }
});

function toggleOfflineMode() {
    if (isOffline === true) {
        updateNetworkUI(false);
    } else {
        updateNetworkUI(true);
    }
}

// 3. SCREEN NAVIGATION
function showScreen(screenId) {
    let allScreens = document.querySelectorAll('.screen');
    for (let i = 0; i < allScreens.length; i++) {
        allScreens[i].classList.remove('active-screen');
    }
    
    document.getElementById(screenId).classList.add('active-screen');
    
    if (screenId === 'screen-activities') {
        filterActivities('All');
    }
    if (screenId === 'screen-saved') {
        renderSavedPlans();
    }
}

// 4. FILTERING ACTIVITIES
function filterActivities(level) {
    let listElement = document.getElementById('activity-list');
    listElement.innerHTML = ''; 
    
    let buttons = document.querySelectorAll('.filter-btn');
    for (let i = 0; i < buttons.length; i++) {
        if (buttons[i].innerText === level) {
            buttons[i].classList.add('active');
        } else {
            buttons[i].classList.remove('active');
        }
    }

    for (let i = 0; i < activities.length; i++) {
        let currentActivity = activities[i];
        
        if (level === 'All' || currentActivity.level === level) {
            listElement.innerHTML += `
                <div class="card">
                    <strong>${currentActivity.title}</strong><br>
                    <small>${currentActivity.level} · ${currentActivity.duration}</small><br>
                    <button class="btn btn-small" onclick="showToast('Saved ${currentActivity.title} to device!')">⬇️ Save for offline</button>
                </div>
            `;
        }
    }
}

// 5. SAVING A PLAN
function savePlan() {
    let titleInput = document.getElementById('plan-title').value;
    
    if (titleInput === "") {
        titleInput = "Untitled Plan";
    }

    let newStatus;
    if (isOffline === true) {
        newStatus = "Pending Sync";
    } else {
        newStatus = "Synced";
    }
    
    let newPlan = {
        id: Date.now(),
        title: titleInput,
        status: newStatus
    };
    savedPlans.push(newPlan);
    
    if (isOffline === true) {
        showToast("Saved locally. Will sync when online.");
    } else {
        showToast("Plan saved and synced!");
    }
    
    // Clear form and change screen
    let inputs = document.querySelectorAll('#screen-create-plan input');
    for (let i = 0; i < inputs.length; i++) {
        inputs[i].value = '';
    }
    showScreen('screen-saved');
}

// 6. SHOWING SAVED PLANS & SYNCING
function renderSavedPlans() {
    let listElement = document.getElementById('saved-plans-list');
    listElement.innerHTML = '';
    
    if (savedPlans.length === 0) {
        listElement.innerHTML = '<p style="text-align:center; color:#666;">No plans created yet.</p>';
        return; 
    }

    for (let i = 0; i < savedPlans.length; i++) {
        let plan = savedPlans[i];
        
        let badgeClass = 'status-pending';
        if (plan.status === 'Synced') {
            badgeClass = 'status-synced';
        } else if (plan.status === 'Failed Sync') {
            badgeClass = 'status-failed';
        }
        
        let extraHTML = '';
        if (plan.status === 'Failed Sync') {
            extraHTML = `
                <div style="margin-top:10px;">
                    <small style="color:red; font-weight:bold;">Conflict: Server has a newer version.</small><br>
                    <button class="btn btn-small" onclick="resolveConflict(${plan.id}, 'server')" style="background-color: #2c3e50; color: white;">Use Server</button>
                    <button class="btn btn-small" onclick="resolveConflict(${plan.id}, 'local')">Keep Local</button>
                </div>
            `;
        }

        listElement.innerHTML += `
            <div class="card">
                <strong>${plan.title}</strong><br>
                <span class="status-badge ${badgeClass}">${plan.status}</span>
                ${extraHTML}
            </div>
        `;
    }
}

function resolveConflict(planId, choice) {
    for (let i = 0; i < savedPlans.length; i++) {
        if (savedPlans[i].id === planId) {
            
            savedPlans[i].status = 'Synced'; 
            
            if (choice === 'server') {
                savedPlans[i].title = savedPlans[i].title + " (Server Version)";
            } else {
                savedPlans[i].title = savedPlans[i].title + " (Local Version)";
            }
            
            renderSavedPlans();
            showToast("Conflict resolved using " + choice + " version.");
            break; 
        }
    }
}

function syncPendingPlans() {
    let syncedCount = 0;
    
    for (let i = 0; i < savedPlans.length; i++) {
        if (savedPlans[i].status === 'Pending Sync') {
            savedPlans[i].status = 'Synced';
            syncedCount = syncedCount + 1;
        }
    }
    
    if (syncedCount > 0) {
        renderSavedPlans();
        showToast(syncedCount + " plan(s) successfully synced to the server!");
    }
}