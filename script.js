/**
 * HealthPulse Pro: Clinical Bayesian Engine (Single Source Edition)
 * Robust probabilistic inference using the Disease & Patient Profile dataset.
 */

const state = {
    records: [],
    diseases: {}, // { name: { count: 0, symptoms: {}, ageGroups: {} } }
    symptoms: [], // Primary symptoms from main dataset
    secondarySymptoms: [], // Additional symptoms from Diseases_Symptoms.csv
    allSymptoms: [], // Combined primary + secondary (10-15 questions)
    ageGroups: [],
    precautions: {}, // { diseaseName: [p1, p2, p3, p4] }
    diseaseMetadata: {}, // { diseaseName: { description, treatments } }
    diseaseSymptomMap: {}, // { diseaseName: [symptom keywords] }
    totalCases: 0,
    minQuestions: 10,
    maxQuestions: 15,
    selections: {
        ageGroup: null,
        gender: null,
        responses: {}
    },
    currentIndex: 0,
    view: 'home'
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
    const startTime = Date.now();
    setupUIListeners();
    try {
        await loadClinicalData();
        await loadPrecautionData();
        await loadDiseaseMetadata();
        await loadSecondarySymptoms();
        combineSymptoms();
        finalizeModel();

        // Ensure loading screen displays for at least 3 seconds
        const elapsedTime = Date.now() - startTime;
        const remainingTime = Math.max(0, 3000 - elapsedTime);

        setTimeout(() => {
            hideLoading();
        }, remainingTime);
    } catch (err) {
        console.error('System Failure:', err);
        updateStatus('Critical Data Synchronization Error', 'loading');
    }
}

// 1. DATA PROCESSING
async function loadClinicalData() {
    const resp = await fetch('./Medical dataset/Disease_symptom_and_patient_profile_dataset.csv');
    if (!resp.ok) throw new Error('Clinical dataset not found');
    const text = await resp.text();
    const rows = text.trim().split('\n').map(line => line.split(',').map(v => v.trim()));

    const headers = rows[0];
    const data = rows.slice(1);

    // Schema: Disease, Fever, Cough, Fatigue, Difficulty Breathing, Age, Gender, Blood Pressure, Cholesterol, Outcome Variable
    const ageIdx = headers.indexOf('Age');
    const genderIdx = headers.indexOf('Gender');
    const symHeaders = headers.slice(1, ageIdx);
    state.symptoms = symHeaders.map(s => s.toLowerCase());

    data.forEach(row => {
        const dName = row[0];
        const age = parseInt(row[ageIdx]);
        const gender = row[genderIdx];

        if (!state.diseases[dName]) {
            state.diseases[dName] = { count: 0, symptoms: {}, genders: {}, ages: [] };
        }

        state.diseases[dName].count++;
        state.diseases[dName].ages.push(age);
        if (gender) {
            state.diseases[dName].genders[gender.toLowerCase()] = (state.diseases[dName].genders[gender.toLowerCase()] || 0) + 1;
        }
        state.totalCases++;

        symHeaders.forEach((h, i) => {
            const symName = h.toLowerCase();
            if (row[i + 1] === 'Yes') {
                state.diseases[dName].symptoms[symName] = (state.diseases[dName].symptoms[symName] || 0) + 1;
            }
        });

        state.records.push({
            disease: dName,
            age: age,
            gender: gender,
            symptoms: Object.fromEntries(symHeaders.map((h, i) => [h.toLowerCase(), row[i + 1]]))
        });
    });

    calculateAgeGroups();
    updateStatus('Clinical Data Synchronized', 'loaded');
}

async function loadPrecautionData() {
    try {
        const resp = await fetch('./Medical dataset/Disease precaution.csv');
        if (!resp.ok) return; // Silent fail for optional data
        const text = await resp.text();
        const rows = text.trim().split('\n').map(line => line.split(',').map(v => v.trim()));

        // Skip header
        rows.slice(1).forEach(row => {
            const disease = row[0];
            if (!disease) return;
            const tips = row.slice(1).filter(tip => tip && tip !== '');
            state.precautions[disease.toLowerCase()] = tips;
        });
    } catch (err) {
        console.warn('Precautions dataset failed to load:', err);
    }
}

async function loadDiseaseMetadata() {
    try {
        const resp = await fetch('./Medical dataset/diseases.csv');
        if (!resp.ok) return; // Silent fail for optional data
        const text = await resp.text();
        const rows = text.trim().split('\n').map(line => {
            // Handle CSV with quoted fields
            const matches = line.match(/(?:"([^"]*)"|([^,]+))(?:,|$)/g);
            return matches ? matches.map(m => m.replace(/^"(.*)",$/, '$1').replace(/,$/, '').trim()) : [];
        });

        // Skip header: disease_id,name,type,description,symptoms,causes,treatments,related_bacteria,related_virus
        rows.slice(1).forEach(row => {
            if (row.length < 7) return;
            const name = row[1];
            const description = row[3];
            const treatments = row[6];

            if (!name) return;

            // Store first occurrence (or you could aggregate multiple entries)
            if (!state.diseaseMetadata[name.toLowerCase()]) {
                state.diseaseMetadata[name.toLowerCase()] = {
                    description: description || null, // Set to null instead of default message
                    treatments: treatments || 'Consult a healthcare professional.'
                };
            }
        });
    } catch (err) {
        console.warn('Disease metadata failed to load:', err);
    }
}

/**
 * Fetch disease description from the internet using Wikipedia API
 * Limits the description to a maximum of 3 sentences
 */
async function fetchDescriptionFromWeb(diseaseName) {
    try {
        console.log('Fetching description for:', diseaseName);

        // Use Wikipedia API to get disease information
        const searchQuery = encodeURIComponent(diseaseName);
        const apiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${searchQuery}`;

        const response = await fetch(apiUrl);

        if (!response.ok) {
            console.warn('Failed to fetch description from Wikipedia for:', diseaseName);
            return 'No description available.';
        }

        const data = await response.json();
        let description = data.extract || '';

        if (description) {
            // Limit to 3 sentences
            const sentences = description.match(/[^.!?]+[.!?]+/g) || [description];
            description = sentences.slice(0, 3).join(' ').trim();
            console.log('Successfully fetched description:', description.substring(0, 100) + '...');
        }

        return description || 'No description available.';
    } catch (err) {
        console.warn('Error fetching description from web:', err);
        return 'No description available.';
    }
}

async function loadSecondarySymptoms() {
    try {
        const resp = await fetch('./Medical dataset/Diseases_Symptoms.csv');
        if (!resp.ok) return; // Silent fail for optional data
        const text = await resp.text();
        const rows = text.trim().split('\n').map(line => {
            // Handle CSV with quoted fields
            const matches = line.match(/(?:"([^"]*)"|([^,]+))(?:,|$)/g);
            return matches ? matches.map(m => m.replace(/^"(.*)",$/, '$1').replace(/,$/, '').trim()) : [];
        });

        // Skip header: Name,Symptoms,Treatments,Disease_Code,Contagious,Chronic
        const symptomCounts = {};

        rows.slice(1).forEach(row => {
            if (row.length < 2) return;
            const diseaseName = row[0];
            const symptomsText = row[1];

            if (!diseaseName || !symptomsText) return;

            // Store disease-symptom mapping for later matching
            state.diseaseSymptomMap[diseaseName.toLowerCase()] = symptomsText.toLowerCase();

            // Extract individual symptoms (split by comma)
            const symptoms = symptomsText.split(',').map(s => s.trim().toLowerCase());

            symptoms.forEach(symptom => {
                if (symptom && symptom.length > 3) { // Filter out very short strings
                    // Normalize symptom text
                    const normalized = symptom
                        .replace(/\(.*?\)/g, '') // Remove parenthetical text
                        .replace(/especially.*$/i, '') // Remove "especially..." clauses
                        .replace(/particularly.*$/i, '') // Remove "particularly..." clauses
                        .trim();

                    if (normalized.length > 3) {
                        symptomCounts[normalized] = (symptomCounts[normalized] || 0) + 1;
                    }
                }
            });
        });

        // Get most common symptoms (excluding ones already in primary symptoms)
        const primarySymptomSet = new Set(state.symptoms);
        const sortedSymptoms = Object.entries(symptomCounts)
            .filter(([sym]) => !primarySymptomSet.has(sym))
            .sort((a, b) => b[1] - a[1])
            .map(([sym]) => sym);

        // Select diverse symptoms from different categories
        const selectedSymptoms = [];
        const categories = {
            respiratory: ['shortness of breath', 'wheezing', 'chest pain', 'chest tightness', 'rapid breathing'],
            gastrointestinal: ['nausea', 'vomiting', 'abdominal pain', 'diarrhea', 'stomach pain', 'loss of appetite'],
            neurological: ['headache', 'dizziness', 'confusion', 'seizures', 'memory loss'],
            general: ['body aches', 'chills', 'weakness', 'sweating', 'weight loss', 'muscle pain'],
            dermatological: ['rash', 'itching', 'skin redness', 'swelling', 'hives'],
            sensory: ['blurred vision', 'sensitivity to light', 'eye pain', 'hearing loss']
        };

        // Try to get at least one from each category
        Object.values(categories).forEach(catSymptoms => {
            const found = sortedSymptoms.find(s =>
                catSymptoms.some(cs => s.includes(cs) || cs.includes(s))
            );
            if (found && !selectedSymptoms.includes(found)) {
                selectedSymptoms.push(found);
            }
        });

        // Fill remaining slots with most common symptoms
        for (const sym of sortedSymptoms) {
            if (selectedSymptoms.length >= 11) break; // We want 11 secondary (4 primary + 11 = 15 total)
            if (!selectedSymptoms.includes(sym)) {
                selectedSymptoms.push(sym);
            }
        }

        state.secondarySymptoms = selectedSymptoms.slice(0, 11);
        console.log('Loaded secondary symptoms:', state.secondarySymptoms);
    } catch (err) {
        console.warn('Secondary symptoms failed to load:', err);
    }
}

function combineSymptoms() {
    // Combine primary and secondary symptoms
    // Use all primary symptoms (4) + enough secondary to reach minQuestions (10)
    const numSecondary = Math.max(
        state.minQuestions - state.symptoms.length,
        Math.min(state.secondarySymptoms.length, state.maxQuestions - state.symptoms.length)
    );

    state.allSymptoms = [
        ...state.symptoms,
        ...state.secondarySymptoms.slice(0, numSecondary)
    ];

    console.log(`Total questions: ${state.allSymptoms.length} (${state.symptoms.length} primary + ${numSecondary} secondary)`);
}

function calculateAgeGroups() {
    const allAges = state.records.map(r => r.age).sort((a, b) => a - b);
    const min = allAges[0];
    const max = allAges[allAges.length - 1];

    // Dynamic Quartile Binning
    const q1 = allAges[Math.floor(allAges.length * 0.25)];
    const q2 = allAges[Math.floor(allAges.length * 0.5)];
    const q3 = allAges[Math.floor(allAges.length * 0.75)];

    state.ageGroups = [
        { label: `${min}-${q1} yrs`, min, max: q1 },
        { label: `${q1 + 1}-${q2} yrs`, min: q1 + 1, max: q2 },
        { label: `${q2 + 1}-${q3} yrs`, min: q2 + 1, max: q3 },
        { label: `${q3 + 1}-${max} yrs`, min: q3 + 1, max }
    ];

    // Pre-calculate priors per age group
    state.ageGroups.forEach(group => {
        const groupRecords = state.records.filter(r => r.age >= group.min && r.age <= group.max);
        group.total = groupRecords.length;
        group.diseasePriors = {};

        groupRecords.forEach(r => {
            group.diseasePriors[r.disease] = (group.diseasePriors[r.disease] || 0) + 1;
        });
    });
}

function finalizeModel() {
    renderAgeGroups();
}

// 2. BAYESIAN ENGINE
function calculateProbabilities() {
    const results = [];
    const Alpha = 1; // Laplace Smoothing
    const selectedGroup = state.selections.ageGroup;

    Object.keys(state.diseases).forEach(dName => {
        const disease = state.diseases[dName];

        // 1. Prior P(D | Age)
        const countInAge = (selectedGroup.diseasePriors[dName] || 0);
        const pPriorAge = (countInAge + Alpha) / (selectedGroup.total + Alpha * Object.keys(state.diseases).length);

        let logLikelihood = Math.log(pPriorAge);
        let matchedSymptomCount = 0;

        // 2. Gender Prior P(Gender | Disease)
        if (state.selections.gender) {
            const genderKey = state.selections.gender.toLowerCase();
            const countInGender = disease.genders[genderKey] || 0;
            const pGenderGivenDisease = (countInGender + Alpha) / (disease.count + Alpha * 2);
            logLikelihood += Math.log(pGenderGivenDisease) * 1.5; // Increased weight
        }

        // 3. Likelihood P(S | D) - Primary Symptoms (from main dataset)
        state.symptoms.forEach(sym => {
            const userResp = state.selections.responses[sym];
            if (!userResp) return;

            const countWithSym = disease.symptoms[sym] || 0;
            const pSymGivenDisease = (countWithSym + Alpha) / (disease.count + Alpha * 2);

            if (userResp === 'Yes') {
                // Strong positive evidence
                if (pSymGivenDisease > 0.3) {
                    logLikelihood += Math.log(pSymGivenDisease) * 3.0; // Strong boost
                    matchedSymptomCount++;
                } else {
                    logLikelihood += Math.log(pSymGivenDisease) * 1.5; // Moderate boost
                }
            } else if (userResp === 'Maybe') {
                // Weak positive evidence
                if (pSymGivenDisease > 0.3) {
                    logLikelihood += Math.log(pSymGivenDisease) * 1.0;
                    matchedSymptomCount += 0.5;
                }
            } else if (userResp === 'No') {
                // NEGATIVE EVIDENCE - crucial for discrimination
                if (pSymGivenDisease > 0.5) {
                    // Disease commonly has this symptom, but user doesn't - strong penalty
                    logLikelihood += Math.log(1 - pSymGivenDisease) * 3.0;
                } else if (pSymGivenDisease > 0.3) {
                    // Disease sometimes has this symptom - moderate penalty
                    logLikelihood += Math.log(1 - pSymGivenDisease) * 1.5;
                }
            }
            // 'Not Sure' - neutral, no change
        });

        // 4. Secondary Symptoms (from Diseases_Symptoms.csv) - Improved Text Matching
        state.secondarySymptoms.forEach(sym => {
            const userResp = state.selections.responses[sym];
            if (!userResp) return;

            const diseaseSymptomText = state.diseaseSymptomMap[dName.toLowerCase()] || '';

            // Better matching: check for partial word matches
            const symptomWords = sym.toLowerCase().split(' ');
            let matchScore = 0;
            symptomWords.forEach(word => {
                if (word.length > 3 && diseaseSymptomText.includes(word)) {
                    matchScore += 1;
                }
            });
            matchScore = matchScore / Math.max(symptomWords.length, 1); // Normalize 0-1

            if (userResp === 'Yes') {
                if (matchScore > 0.7) {
                    // Strong match
                    logLikelihood += Math.log(0.9) * 2.0;
                    matchedSymptomCount++;
                } else if (matchScore > 0.3) {
                    // Partial match
                    logLikelihood += Math.log(0.7) * 1.0;
                    matchedSymptomCount += 0.5;
                } else {
                    // No match - penalty
                    logLikelihood += Math.log(0.2) * 0.5;
                }
            } else if (userResp === 'Maybe') {
                if (matchScore > 0.5) {
                    logLikelihood += Math.log(0.7) * 0.8;
                    matchedSymptomCount += 0.3;
                }
            } else if (userResp === 'No') {
                // Negative evidence for secondary symptoms
                if (matchScore > 0.7) {
                    // Disease has this symptom but user doesn't - penalty
                    logLikelihood += Math.log(0.3) * 1.5;
                }
            }
        });

        // 5. Bonus for matching multiple symptoms (specificity bonus)
        if (matchedSymptomCount > 0) {
            logLikelihood += Math.log(1 + matchedSymptomCount * 0.15) * 2.0;
        }

        results.push({
            name: dName,
            logLikelihood,
            cases: disease.count,
            countInAge,
            matchedSymptoms: matchedSymptomCount
        });
    });

    // Normalization with better scaling
    const maxLog = Math.max(...results.map(r => r.logLikelihood));
    const minLog = Math.min(...results.map(r => r.logLikelihood));
    const logRange = maxLog - minLog;

    // Apply exponential scaling for better discrimination
    const exps = results.map(r => {
        const normalizedLog = (r.logLikelihood - minLog) / (logRange || 1);
        return { ...r, exp: Math.exp(normalizedLog * 5) }; // Scale factor for discrimination
    });

    const sumExp = exps.reduce((a, b) => a + b.exp, 0);

    return exps.map(r => ({
        ...r,
        probability: (r.exp / sumExp) * 100
    })).sort((a, b) => b.probability - a.probability);
}

// 3. UI CONTROLLER
function setupUIListeners() {
    document.getElementById('start-btn').onclick = () => switchView('symptoms');
    document.getElementById('back-btn').onclick = handleBack;
    document.getElementById('reset-btn').onclick = resetApp;
    document.getElementById('restart-btn').onclick = resetApp;
    document.getElementById('export-btn').onclick = exportAnalysis;

    document.querySelectorAll('.gender-chip').forEach(chip => {
        chip.onclick = () => {
            document.querySelectorAll('.gender-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            state.selections.gender = chip.dataset.gender;
            checkProfileCompletion();
        };
    });

    document.querySelectorAll('.resp-btn').forEach(btn => {
        btn.onclick = () => handleSymptomResponse(btn.dataset.value);
    });

    document.getElementById('app-nav').onclick = (e) => {
        if (e.target.dataset.view) switchView(e.target.dataset.view);
    };
}

function handleBack() {
    if (state.currentIndex > 0) {
        state.currentIndex--;
        renderQuestion();
    }
}

function renderAgeGroups() {
    const container = document.getElementById('age-group-cards');
    container.innerHTML = state.ageGroups.map((group, idx) => `
        <div class="selection-card" data-idx="${idx}">
            <div class="card-label">Age Bracket</div>
            <div class="card-value">${group.label}</div>
        </div>
    `).join('');

    container.querySelectorAll('.selection-card').forEach(card => {
        card.onclick = () => {
            container.querySelectorAll('.selection-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            state.selections.ageGroup = state.ageGroups[card.dataset.idx];
            checkProfileCompletion();
        };
    });
}

function checkProfileCompletion() {
    if (state.selections.ageGroup && state.selections.gender) {
        document.getElementById('hero-start-container').classList.remove('hidden');
    }
}

function handleSymptomResponse(val) {
    const sym = state.allSymptoms[state.currentIndex];
    state.selections.responses[sym] = val;

    if (state.currentIndex < state.allSymptoms.length - 1) {
        state.currentIndex++;
        renderQuestion();
    } else {
        runAnalysis();
    }
}

function renderQuestion() {
    const idx = state.currentIndex;
    const sym = state.allSymptoms[idx];

    // Capitalize first letter for display
    const displaySym = sym.charAt(0).toUpperCase() + sym.slice(1);
    document.getElementById('current-symptom-name').textContent = `Do you have ${displaySym}?`;
    document.getElementById('symptom-counter').textContent = `Clinical Indicator ${idx + 1} of ${state.allSymptoms.length}`;

    const progress = ((idx + 1) / state.allSymptoms.length) * 100;
    document.getElementById('progress-bar').style.width = `${progress}%`;

    // Manage Back Button
    const backBtn = document.getElementById('back-btn');
    if (idx > 0) {
        backBtn.classList.remove('hidden');
    } else {
        backBtn.classList.add('hidden');
    }

    // Reset button highlights and restore previous selection if any
    document.querySelectorAll('.resp-btn').forEach(btn => {
        btn.blur(); // Remove focus
        btn.classList.remove('active-response'); // Remove active style

        // If there is a saved response, highlight it
        if (state.selections.responses[sym] === btn.dataset.value) {
            btn.classList.add('active-response');
        }
    });
}

async function runAnalysis() {
    switchView('analysis');
    const steps = ['Aggregating prior probabilities...', 'Iterating clinical likelihoods...', 'Applying Bayesian revision...', 'Finalizing diagnostic inference...'];

    for (let msg of steps) {
        document.getElementById('analysis-step').textContent = msg;
        await new Promise(r => setTimeout(r, 600));
    }

    const predictions = calculateProbabilities();
    await renderResults(predictions);
}

async function renderResults(preds) {
    switchView('results');
    document.getElementById('results-count-summary').textContent = `Calculated using Naive Bayesian Inference based on ${state.records.length} clinical records.`;

    const primary = preds[0];
    const secondary = preds.slice(1, 4);

    // Get disease metadata
    const metadata = state.diseaseMetadata[primary.name.toLowerCase()] || {};
    let description = metadata.description;
    const treatments = metadata.treatments || 'Consult a healthcare professional.';

    // If description is missing, null, empty, or shows default message, fetch from the internet
    if (!description || description === '' || description === 'No description available.') {
        console.log('Description missing for:', primary.name, '- fetching from web');
        // Show loading indicator first
        renderPrimaryDiagnosis(primary, '🔍 Fetching description from the internet...', treatments);

        // Fetch from web
        description = await fetchDescriptionFromWeb(primary.name);
        console.log('Fetched description:', description);

        // Cache the fetched description
        if (!state.diseaseMetadata[primary.name.toLowerCase()]) {
            state.diseaseMetadata[primary.name.toLowerCase()] = {};
        }
        state.diseaseMetadata[primary.name.toLowerCase()].description = description;
    }

    // Render the final view with actual description
    renderPrimaryDiagnosis(primary, description, treatments);

    // Render secondary results
    document.getElementById('secondary-list').innerHTML = secondary.map(r => `
        <div class="mini-card">
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 1rem;">
                <h4 style="font-size: 1.2rem;">${r.name}</h4>
                <span style="color: var(--accent-teal); font-weight: 700;">${r.probability.toFixed(1)}%</span>
            </div>
            <div style="height: 4px; background: rgba(255,255,255,0.05); border-radius: 2px; margin-top: 1rem;">
                <div style="width: ${r.probability}%; height: 100%; background: var(--accent-purple); border-radius: 2px;"></div>
            </div>
        </div>
    `).join('');
}

/**
 * Render the primary diagnosis card with description and treatments
 */
function renderPrimaryDiagnosis(primary, description, treatments) {
    document.getElementById('primary-diagnosis').innerHTML = `
        <div class="primary-result-card">
            <div class="result-main">
                <h2>Diagnostic Probability</h2>
                <h1>${primary.name}</h1>
                <div class="result-tags">
                    <span class="agreement-tag">High Clinical Correlation</span>
                    <span class="mono" style="opacity: 0.7;">Matched ${primary.countInAge} cases in your age group</span>
                </div>
            </div>
            <div class="prob-score-large">
                <div class="prob-circle">
                    <span>${primary.probability.toFixed(1)}%</span>
                    <span class="prob-label">Clinical Probability</span>
                </div>
            </div>
        </div>
        
        <div class="disease-info-section">
            <div class="info-block">
                <h3>📋 Description</h3>
                <p class="disease-description">${description}</p>
            </div>
            
            <div class="info-block">
                <h3>💊 Treatment Options</h3>
                <p class="treatment-info">${treatments}</p>
            </div>
        </div>
    `;

    // Render Precautions
    const precautionTips = state.precautions[primary.name.toLowerCase()] || [];
    if (precautionTips.length > 0) {
        document.getElementById('primary-diagnosis').innerHTML += `
            <div class="precaution-container">
                <h3>⚠️ Recommended Precautions</h3>
                <div class="precaution-grid">
                    ${precautionTips.map(tip => `
                        <div class="precaution-item">
                            <span class="dot"></span>
                            <span>${tip}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }
}

// UTILS
function switchView(id) {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.getElementById(`view-${id}`).classList.remove('hidden');
    if (id === 'symptoms') renderQuestion();
}

function updateStatus(msg, status) {
    const el = document.getElementById('data-status');
    el.textContent = msg;
    el.className = `status-badge ${status}`;
    document.getElementById('loading-status').textContent = msg;
}

function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.add('slide-up');
    setTimeout(() => overlay.remove(), 1000); // Match CSS transition duration
}

function resetApp() {
    state.selections = { ageGroup: null, gender: null, responses: {} };
    state.currentIndex = 0;
    document.querySelectorAll('.selection-card').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.gender-chip').forEach(c => c.classList.remove('active'));
    document.getElementById('hero-start-container').classList.add('hidden');
    switchView('home');
}

async function exportAnalysis() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    // 1. Header
    doc.setFontSize(22);
    doc.setTextColor(5, 8, 15); // Dark background color as text? No, let's use standard black for PDF readability
    doc.setTextColor(0, 0, 0);
    doc.text("HealthPulse Pro", 20, 20);

    doc.setFontSize(12);
    doc.setTextColor(100, 100, 100);
    doc.text("Clinical Intelligence Report", 20, 28);

    doc.setLineWidth(0.5);
    doc.line(20, 32, 190, 32);

    // 2. Metadata
    const date = new Date().toLocaleString();
    doc.setFontSize(10);
    doc.setTextColor(50, 50, 50);
    doc.text(`Date: ${date}`, 20, 40);
    doc.text(`Profile: ${state.selections.ageGroup.label} | ${state.selections.gender}`, 20, 46);

    // 3. Primary Diagnosis
    const preds = calculateProbabilities(); // Recalculate or store previous results? safely recalculate
    const primary = preds[0];
    const metadata = state.diseaseMetadata[primary.name.toLowerCase()] || {};

    doc.setFontSize(16);
    doc.setTextColor(0, 51, 102); // Dark Blue
    doc.text("Primary Diagnosis", 20, 60);

    doc.setFontSize(14);
    doc.setTextColor(0, 0, 0);
    doc.text(`${primary.name} (${primary.probability.toFixed(1)}%)`, 20, 70);

    doc.setFontSize(10);
    doc.setTextColor(80, 80, 80);
    const splitDesc = doc.splitTextToSize(metadata.description || "No description available.", 170);
    doc.text(splitDesc, 20, 80);

    let yPos = 80 + (splitDesc.length * 5) + 10;

    // Treatments
    doc.setFontSize(12);
    doc.setTextColor(0, 51, 102);
    doc.text("Recommended Treatments", 20, yPos);
    yPos += 8;

    doc.setFontSize(10);
    doc.setTextColor(0, 0, 0);
    const splitTreat = doc.splitTextToSize(metadata.treatments || "Consult a healthcare professional.", 170);
    doc.text(splitTreat, 20, yPos);

    yPos += (splitTreat.length * 5) + 15;

    // 4. Secondary Diagnoses
    doc.setFontSize(12);
    doc.setTextColor(0, 51, 102);
    doc.text("Other Potential Conditions", 20, yPos);
    yPos += 8;

    preds.slice(1, 4).forEach(p => {
        doc.setFontSize(10);
        doc.setTextColor(0, 0, 0);
        doc.text(`- ${p.name}: ${p.probability.toFixed(1)}%`, 20, yPos);
        yPos += 6;
    });

    // 5. Disclaimer
    yPos = 280; // Bottom of page
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text("DISCLAIMER: This report is generated by an AI-based system and is for informational purposes only.", 20, yPos);
    doc.text("It is not a substitute for professional medical advice, diagnosis, or treatment.", 20, yPos + 4);

    // Save
    doc.save(`HealthPulse_Report_${Date.now()}.pdf`);
}


