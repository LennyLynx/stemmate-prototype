let isOffline = false;

let savedPlans = [
    { id: 1, title: "Previous Session", status: "Failed Sync" }
];

let activities = [
    { title: "Paper Bridge Challenge", level: "Beginner", duration: "45 min" },
    { title: "Vinegar & Baking Soda", level: "Beginner", duration: "30 min" },
    { title: "Seed Germination Study", level: "Intermediate", duration: "60 min" },
    { title: "Pendulum Patterns", level: "Intermediate", duration: "45 min" },
    { title: "Advanced Robotics", level: "Advance", duration: "90 min" }
];

// Show a simple pop-up message at the bottom of the screen
function showToast(message) {
    let toast = document.getElementById('toast-message');
    toast.innerText = message;
    toast.style.display = 'block';
    
    // Hide it again after 3 seconds
    setTimeout(function() {
        toast.style.display = 'none';
    }, 3000);
}

// NETWORK CONNECTION LOGIC
let manualOverride = false; // This tells the computer if you clicked the button

function updateNetworkUI(offlineState) {
    isOffline = offlineState;
    let banner = document.getElementById('offline-banner');
    let statusText = document.getElementById('network-status-text');
    
    if (isOffline === true) {
        banner.classList.add('is-offline');
        banner.innerHTML = "<strong>Offline</strong><br><small>We will save your work to the phone.</small>";
        statusText.innerText = "Offline";
    } else {
        banner.classList.remove('is-offline');
        banner.innerHTML = "<strong>Online</strong><br><small>Tap here to turn off internet.</small>";
        statusText.innerText = "Online";
        
        syncPendingPlans(); 
    }
}

// 1. Automatic Timer (Checks every 1 second)
setInterval(function() {
    // Only check automatically if the user HAS NOT manually clicked the banner
    if (manualOverride === false) {
        if (navigator.onLine === false && isOffline === false) {
            updateNetworkUI(true); // Wi-Fi turned off
        } else if (navigator.onLine === true && isOffline === true) {
            updateNetworkUI(false); // Wi-Fi turned back on
        }
    }
}, 1000);

// 2. Manual toggle for your video demonstration
function toggleOfflineMode() {
    if (isOffline === true) {
        // Turn internet back on, and let the automatic timer start working again
        manualOverride = false;
        updateNetworkUI(false);
    } else {
        // Force internet off, and tell the automatic timer to stop interfering
        manualOverride = true;
        updateNetworkUI(true);
    }
}

// SCREEN NAVIGATION (This is the part that was missing!)
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

// FILTERING ACTIVITIES
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
                    <button class="btn btn-small" onclick="showToast('Saved to phone!')">Save to phone</button>
                </div>
            `;
        }
    }
}

// SAVING A PLAN
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
        showToast("Saved to phone. Will upload later.");
    } else {
        showToast("Plan saved and uploaded!");
    }
    
    // Clear form and change screen
    let inputs = document.querySelectorAll('#screen-create-plan input');
    for (let i = 0; i < inputs.length; i++) {
        inputs[i].value = '';
    }
    showScreen('screen-saved');
}

// SHOWING SAVED PLANS & SYNCING
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
                    <small style="color:red; font-weight:bold;">Wait: There is a newer version online.</small><br>
                    <button class="btn btn-small" onclick="resolveConflict(${plan.id}, 'server')" style="background-color: #2c3e50; color: white;">Keep Online Version</button>
                    <button class="btn btn-small" onclick="resolveConflict(${plan.id}, 'local')">Keep My Phone Version</button>
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
                savedPlans[i].title = savedPlans[i].title + " (Online Version)";
            } else {
                savedPlans[i].title = savedPlans[i].title + " (Phone Version)";
            }
            
            renderSavedPlans();
            showToast("Fixed! We saved the " + choice + " version.");
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
        showToast(syncedCount + " plan(s) uploaded successfully!");
    }
}