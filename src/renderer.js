const { ipcRenderer } = require('electron');
const path = require('path');
const { dialog } = require('@electron/remote');
const fs = require('fs').promises;

// Global WebSocket connection
let ws = null;

// Add these constants at the top of the file
const SAMPLE_RATE = 51200; // Sampling rate in Hz
const MAX_POINTS = 50000;  // Maximum points to display for smooth rendering

// Add this global variable at the top with the other globals
let currentPlot = null;

// Add these global variables at the top
let selectedItems = [];
let calibrationResults = null;
let selectedFolderPaths = new Map();

// Add this global variable at the top to track checked items
let checkedPaths = new Set();

// Add this at the top with other global variables
const configResolvers = new Map();
const configData = new Map();

// Add efficient data caching
const dataCache = new Map();
const CACHE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

function cacheData(key, data) {
    dataCache.set(key, {
        data,
        timestamp: Date.now()
    });
}

function getCachedData(key) {
    const cached = dataCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TIMEOUT) {
        return cached.data;
    }
    dataCache.delete(key);
    return null;
}

// Function to make the left container resizable
function initializeResizer() {
    const resizer = document.getElementById('left-container-resizer');
    const leftContainer = document.getElementById('left-container');
    let startX;
    let startWidth;

    function startResizing(e) {
        startX = e.clientX;
        startWidth = parseInt(window.getComputedStyle(leftContainer).width, 10);
        document.body.classList.add('resizing');
        resizer.classList.add('active');
        document.addEventListener('mousemove', resize);
        document.addEventListener('mouseup', stopResizing);
    }

    function resize(e) {
        const width = startWidth + (e.clientX - startX);
        if (width >= 200 && width <= 800) {
            leftContainer.style.width = `${width}px`;
            
            // Update plot if it exists
            const plot = document.getElementById('timeseries-plot');
            if (plot && plot.layout) {
                Plotly.relayout(plot, { autosize: true });
            }
        }
    }

    function stopResizing() {
        document.body.classList.remove('resizing');
        resizer.classList.remove('active');
        document.removeEventListener('mousemove', resize);
        document.removeEventListener('mouseup', stopResizing);
    }

    resizer.addEventListener('mousedown', startResizing);
}

// Add current directory tracking
let currentDirectory = '';

function requestDirectoryContents(dirPath) {
    if (!ws) return;
    currentDirectory = dirPath;
    console.log('Requesting directory contents for:', dirPath);
    ws.send(JSON.stringify({
        type: 'listDirectory',
        path: dirPath
    }));
}

function renderFileTree(files) {
    const itemList = document.getElementById('item-list');
    const fragment = document.createDocumentFragment();
    
    if (currentDirectory && currentDirectory !== '/') {
        const dirUp = document.createElement('div');
        dirUp.className = 'directory-up';
        dirUp.textContent = '...';
        dirUp.addEventListener('click', () => {
            requestDirectoryContents(path.dirname(currentDirectory));
        });
        fragment.appendChild(dirUp);
    }
    
    const elements = files.map(file => {
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item';
        fileItem.setAttribute('data-type', file.isDir ? 'folder' : 'file');
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = file.path;
        checkbox.checked = checkedPaths.has(file.path);
        
        const label = document.createElement('label');
        label.htmlFor = file.path;
        label.textContent = file.name;
        
        if (file.isDir) {
            label.style.cursor = 'pointer';
            label.addEventListener('click', (e) => {
                e.preventDefault();
                requestDirectoryContents(file.path);
            });
        }
        
        checkbox.addEventListener('change', (event) => {
            event.stopPropagation();
            if (event.target.checked) {
                checkedPaths.add(file.path);
                if (!selectedItems.some(item => item.path === file.path)) {
                    selectedItems.push({
                        name: file.name,
                        path: file.path,
                        isDir: file.isDir
                    });
                }
            } else {
                checkedPaths.delete(file.path);
                selectedItems = selectedItems.filter(item => item.path !== file.path);
            }
        });
        
        fileItem.appendChild(checkbox);
        fileItem.appendChild(label);
        return fileItem;
    });
    
    elements.forEach(el => fragment.appendChild(el));
    itemList.textContent = '';
    itemList.appendChild(fragment);
}

/**
 * Creates a plot with the given time series data
 * @param {Array<number>} times - Array of time points
 * @param {Array<number>} values - Array of corresponding values
 * @param {Array<string>} fileNames - Array of file names for the legend
 */
function createPlot(times, values, fileNames) {
    // Clear and initialize the plot container
    const plotContainer = document.getElementById('plot-container');
    plotContainer.innerHTML = '<div id="timeseries-plot" class="plot"></div>';

    const layout = {
        title: 'Time Series Data',
        xaxis: { title: 'Time (s)' },
        yaxis: { title: 'Value' },
        plot_bgcolor: 'white',
        paper_bgcolor: 'white'
    };

    // Optimize trace creation with better memory management
    const traces = fileNames.map((fileName, i) => {
        const start = i * times.length / fileNames.length;
        const end = (i + 1) * times.length / fileNames.length;
        
        // Pre-allocate arrays for better memory efficiency
        const xData = new Float64Array(end - start);
        const yData = new Float64Array(end - start);
        
        for (let j = 0; j < end - start; j++) {
            xData[j] = times[start + j] / SAMPLE_RATE;
            yData[j] = values[start + j];
        }

        return {
            x: xData,
            y: yData,
            type: 'scattergl',
            mode: 'lines+markers',
            name: fileName,
            line: { width: 1 },
            marker: { size: 2 }
        };
    });

    // Use more efficient plot options
    const config = {
        responsive: true,
        displayModeBar: true,
        modeBarButtonsToRemove: ['lasso2d', 'select2d'],
        displaylogo: false,
        doubleClick: 'reset',  // More efficient than custom handler
        scrollZoom: true       // More efficient than custom wheel handler
    };

    // Initialize plot with optimized config
    Plotly.newPlot('timeseries-plot', traces, layout, config);

    const plot = document.getElementById('timeseries-plot');

    // Handle zoom events
    plot.on('plotly_relayout', function(eventdata) {
        if (eventdata['xaxis.range[0]'] !== undefined && 
            eventdata['xaxis.range[1]'] !== undefined) {
            requestNewData(eventdata['xaxis.range[0]'], eventdata['xaxis.range[1]']);
        } else if (eventdata['xaxis.autorange'] === true) {
            // Handle complete zoom out
            const selectedFiles = getSelectedBinFiles();
            if (selectedFiles.length > 0) {
                ws.send(JSON.stringify({
                    type: 'getTotalLength',
                    files: selectedFiles
                }));
            }
        }
    });

    // Handle wheel zoom
    plot.addEventListener('wheel', function(event) {
        event.preventDefault();
        const layout = plot.layout;
        const xaxis = layout.xaxis;
        const yaxis = layout.yaxis;

        const mouseX = event.offsetX / plot.clientWidth;
        const mouseY = 1 - (event.offsetY / plot.clientHeight);

        const zoomFactor = event.deltaY > 0 ? 0.9 : 1.1;

        if (event.ctrlKey) {
            // Vertical zoom
            const ymin = yaxis.range[0];
            const ymax = yaxis.range[1];
            const ycenter = ymin + (ymax - ymin) * mouseY;
            const ynewMin = ycenter - (ycenter - ymin) / zoomFactor;
            const ynewMax = ycenter + (ymax - ycenter) / zoomFactor;
            Plotly.relayout(plot, {'yaxis.range': [ynewMin, ynewMax]});
        } else {
            // Horizontal zoom
            const xmin = xaxis.range[0];
            const xmax = xaxis.range[1];
            const xcenter = xmin + (xmax - xmin) * mouseX;
            const xnewMin = xcenter - (xcenter - xmin) / zoomFactor;
            const xnewMax = xcenter + (xmax - xcenter) / zoomFactor;
            Plotly.relayout(plot, {'xaxis.range': [xnewMin, xnewMax]})
                .then(() => {
                    requestNewData(xnewMin, xnewMax);
                });
        }
    });

    // Double-click to reset view
    plot.addEventListener('dblclick', function(event) {
        event.preventDefault();
        Plotly.relayout(plot, {
            'xaxis.autorange': true,
            'yaxis.autorange': true
        });
    });

    return {
        update: function(newTimes, newValues) {
            const traces = fileNames.map((fileName, i) => {
                const start = i * newTimes.length / fileNames.length;
                const end = (i + 1) * newTimes.length / fileNames.length;
                return {
                    x: newTimes.slice(start, end).map(t => t / SAMPLE_RATE),
                    y: newValues.slice(start, end),
                    type: 'scattergl',
                    mode: 'lines+markers',
                    name: fileName,
                    line: { width: 1 },
                    marker: { size: 2 }
                };
            });
            Plotly.react('timeseries-plot', traces, layout);
        }
    };
}

/**
 * Requests new data from the backend based on zoom level
 * @param {number} startTime - Start time in seconds
 * @param {number} endTime - End time in seconds
 */
async function requestNewData(startTime, endTime) {
    const selectedFiles = getSelectedBinFiles();
    if (!selectedFiles.length) return;

    const startIndex = Math.max(0, Math.floor(startTime * SAMPLE_RATE));
    const endIndex = Math.ceil(endTime * SAMPLE_RATE);
    
    // Check cache first
    const cacheKey = `${selectedFiles.join(',')}:${startIndex}:${endIndex}`;
    const cachedData = getCachedData(cacheKey);
    if (cachedData) {
        if (currentPlot) {
            currentPlot.update(cachedData.times, cachedData.values);
        }
        return;
    }

    // Calculate decimation factor
    const pointsInView = endIndex - startIndex;
    const plotWidth = document.getElementById('timeseries-plot').clientWidth;
    const minPointsPerPixel = 2;
    const targetPoints = plotWidth * minPointsPerPixel;
    const decimationFactor = Math.max(1, Math.floor(pointsInView / targetPoints));

    if (ws) {
        ws.send(JSON.stringify({
            type: 'plot',
            files: selectedFiles,
            startIndex: startIndex,
            endIndex: endIndex,
            decimationFactor: decimationFactor
        }));
    }
}

/**
 * Gets selected .bin files from the file tree
 * @returns {Array<string>} Array of selected .bin file paths
 */
function getSelectedBinFiles() {
    const checkboxes = document.querySelectorAll('#item-list input[type="checkbox"]:checked');
    return Array.from(checkboxes)
        .map(checkbox => checkbox.id)  // checkbox.id contains the full path
        .filter(filePath => {
            if (!filePath.endsWith('.bin')) return false;
            console.log('Selected file path:', filePath); // Debug log
            return true;
        });
}

/**
 * Clears all checkbox selections in the file tree
 */
function clearSelections() {
    const checkboxes = document.querySelectorAll('#item-list input[type="checkbox"]');
    checkboxes.forEach(checkbox => checkbox.checked = false);
    checkedPaths.clear();  // Clear the stored paths
    selectedItems = [];    // Clear selected items
}

function setupEventListeners() {
    document.getElementById('uncheck-all').addEventListener('click', clearSelections);

    document.getElementById('select-folder').addEventListener('click', () => {
        console.log('Select folder clicked');
        ipcRenderer.send('open-folder-dialog');
    });

    document.getElementById('calibrate').addEventListener('click', () => {
        console.log('Calibrate button clicked');
        
        // Get all selected directories from checkedPaths
        const selectedDirs = getSelectedDirectories();
        console.log('All selected directories:', selectedDirs);

        if (selectedDirs.length === 0) {
            alert('Please select at least one folder for calibration.');
            return;
        }

        // Create calibration items from all selected directories
        const calibrationItems = selectedDirs.map(dir => {
            const dirName = path.basename(dir);
            console.log('Creating calibration item for directory:', dir);
            return {
                station: dirName,
                waveform: 'Square',
                frequency: 0,
                tx: 'channel2.bin',
                rx: 'channel1.bin',
                coil: 'Coil 1'
            };
        });

        // Position and show the calibration window
        const calibrationWindow = document.getElementById('calibration-window');
        calibrationWindow.style.top = '50%';
        calibrationWindow.style.left = '50%';
        calibrationWindow.style.transform = 'translate(-50%, -50%)';
        
        showCalibrationWindow(calibrationItems);
    });

    document.getElementById('plot').addEventListener('click', () => {
        const selectedFiles = getSelectedBinFiles();
        if (selectedFiles.length === 0) {
            alert('Please select at least one .bin file to plot');
            return;
        }

        // Verify that all files exist and have full paths
        const validFiles = selectedFiles.filter(file => file && file.endsWith('.bin'));
        if (validFiles.length === 0) {
            alert('No valid .bin files selected');
            return;
        }

        console.log('Selected files for plotting:', validFiles); // Debug log

        // Clear any existing plot
        const plotContainer = document.getElementById('plot-container');
        plotContainer.innerHTML = '<div id="timeseries-plot" class="plot"></div>';
        currentPlot = null;

        // First get the total length
        if (ws) {
            ws.send(JSON.stringify({
                type: 'getTotalLength',
                files: validFiles // Use validated file paths
            }));
        }
    });

    document.getElementById('clear-plots').addEventListener('click', () => {
        const plotContainer = document.getElementById('plot-container');
        // Reset the container to its original state with a single empty plot div
        plotContainer.innerHTML = '<div id="timeseries-plot" class="plot"></div>';
        currentPlot = null;
    });

    document.querySelector('.minimize-button').addEventListener('click', () => {
        require('@electron/remote').getCurrentWindow().minimize();
    });

    document.querySelector('.maximize-button').addEventListener('click', () => {
        const currentWindow = require('@electron/remote').getCurrentWindow();
        if (currentWindow.isMaximized()) {
            currentWindow.unmaximize();
        } else {
            currentWindow.maximize();
        }
    });

    document.querySelector('.close-button').addEventListener('click', () => {
        require('@electron/remote').getCurrentWindow().close();
    });
}

function getSelectedFiles() {
    const checkboxes = document.querySelectorAll('#item-list input[type="checkbox"]:checked');
    return Array.from(checkboxes).map(checkbox => checkbox.id);
}

function connectToBackend(port) {
    ws = new WebSocket(`ws://localhost:${port}/ws`);

    ws.onopen = () => {
        console.log(`Connected to Go backend on port ${port}`);
    };

    ws.onclose = () => {
        console.log('Disconnected from Go backend');
        ws = null;
        if (port < 8180) {
            setTimeout(() => connectToBackend(port + 1), 1000);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        ws = null;
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log('Received from Go backend:', data);
        
        switch (data.type) {
            case 'directoryContents':
                renderFileTree(data.files);
                break;
            case 'totalLength':
                // After getting total length, request initial plot
                const selectedFiles = getSelectedBinFiles();
                if (selectedFiles.length > 0) {
                    ws.send(JSON.stringify({
                        type: 'plot',
                        files: selectedFiles,
                        startIndex: 0,
                        endIndex: data.totalLength,
                        decimationFactor: Math.max(1, Math.floor(data.totalLength / MAX_POINTS))
                    }));
                }
                break;
            case 'plotData':
                const fileNames = getSelectedBinFiles().map(filePath => path.basename(filePath));
                if (!currentPlot) {
                    currentPlot = createPlot(data.times, data.values, fileNames);
                } else {
                    currentPlot.update(data.times, data.values);
                }
                break;
            case 'error':
                alert(data.message);
                break;
            case 'calibrationProgress':
                console.log('Calibration progress:', data.progress);
                updateCalibrationProgress(data.progress);
                break;
            case 'calibrationResults':
                console.log('Calibration results:', data.results);
                handleCalibrationResults(data.results);
                break;
            default:
                console.log('Unknown message type:', data.type);
        }
    };
}

// Initialize everything when the document is loaded
document.addEventListener('DOMContentLoaded', () => {
    initializeResizer();
    setupEventListeners();
    connectToBackend(8080);
});

// Handle folder selection response
ipcRenderer.on('selected-folder', (event, folderPath) => {
    console.log('Selected folder:', folderPath);
    if (folderPath) {
        requestDirectoryContents(folderPath);
    }
});

/**
 * Clears all checkbox selections in the file tree
 */
function clearSelections() {
    const checkboxes = document.querySelectorAll('#item-list input[type="checkbox"]');
    checkboxes.forEach(checkbox => checkbox.checked = false);
    checkedPaths.clear();  // Clear the stored paths
    selectedItems = [];    // Clear selected items
}

function getSelectedDirectories() {
    // Instead of looking at currently visible checkboxes,
    // use the checkedPaths Set to get all checked directories
    return Array.from(checkedPaths).filter(path => {
        // Check if the path is a directory by looking at the stored selectedItems
        const item = selectedItems.find(item => item.path === path);
        return item && item.isDir;
    });
}

function checkForConfigFile(dirPath) {
    // We'll implement this with the backend
    return true; // Temporary
}

function checkForBinFiles(dirPath) {
    // We'll implement this with the backend
    return true; // Temporary
}

function showCalibrationWindow(calibrationItems) {
    console.log('Showing calibration window with items:', calibrationItems); // Debug log

    const calibrationWindow = document.getElementById('calibration-window');
    if (!calibrationWindow) {
        console.error('Calibration window element not found!');
        return;
    }

    // Clear existing content
    const calibrationTableBody = document.getElementById('calibration-items');
    if (!calibrationTableBody) {
        console.error('Calibration table body not found!');
        return;
    }
    calibrationTableBody.innerHTML = '';

    // Create table rows
    calibrationItems.forEach(item => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${item.station}</td>
            <td>
                <select>
                    <option value="Square" ${item.waveform === 'Square' ? 'selected' : ''}>Square</option>
                    <option value="Sine" ${item.waveform === 'Sine' ? 'selected' : ''}>Sine</option>
                </select>
            </td>
            <td><input type="number" value="${item.frequency}" step="any"></td>
            <td>
                <select>
                    <option value="channel1.bin" ${item.tx === 'channel1.bin' ? 'selected' : ''}>channel1.bin</option>
                    <option value="channel2.bin" ${item.tx === 'channel2.bin' ? 'selected' : ''}>channel2.bin</option>
                    <option value="channel3.bin" ${item.tx === 'channel3.bin' ? 'selected' : ''}>channel3.bin</option>
                </select>
            </td>
            <td>
                <select>
                    <option value="channel1.bin" ${item.rx === 'channel1.bin' ? 'selected' : ''}>channel1.bin</option>
                    <option value="channel2.bin" ${item.rx === 'channel2.bin' ? 'selected' : ''}>channel2.bin</option>
                    <option value="channel3.bin" ${item.rx === 'channel3.bin' ? 'selected' : ''}>channel3.bin</option>
                </select>
            </td>
            <td>
                <select>
                    <option value="Coil 1" ${item.coil === 'Coil 1' ? 'selected' : ''}>Coil 1</option>
                    <option value="Coil 2" ${item.coil === 'Coil 2' ? 'selected' : ''}>Coil 2</option>
                    <option value="Coil 3" ${item.coil === 'Coil 3' ? 'selected' : ''}>Coil 3</option>
                </select>
            </td>
        `;
        calibrationTableBody.appendChild(row);
    });

    // Reset progress and status
    const progressBar = document.getElementById('calibration-progress-bar');
    const statusLabel = document.getElementById('calibration-status');
    if (progressBar) progressBar.style.width = '0%';
    if (statusLabel) statusLabel.textContent = '';

    // Update export button text and ensure it's disabled
    const exportButton = document.getElementById('export-results');
    exportButton.textContent = 'Export Results';
    exportButton.disabled = true;

    // Add event listeners for buttons
    document.getElementById('run-calibration').addEventListener('click', () => {
        console.log('Run calibration clicked');
        // Disable export button when starting new calibration
        exportButton.disabled = true;
        const calibrationData = getCalibrationDataFromTable();
        console.log('Calibration data:', calibrationData);
        runCalibration(calibrationData);
    });

    document.getElementById('close-calibration').addEventListener('click', () => {
        calibrationWindow.style.display = 'none';
    });

    document.getElementById('import-from-config').addEventListener('click', importFromConfig);
    document.getElementById('export-results').addEventListener('click', exportResultsToCSV);

    // Show the window
    calibrationWindow.style.display = 'block';

    // Initialize dragging functionality
    initializeCalibrationWindowDrag(calibrationWindow);
}

function initializeCalibrationWindowDrag(window) {
    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;

    window.addEventListener('mousedown', e => {
        if (e.target.tagName.toLowerCase() === 'select' || 
            e.target.tagName.toLowerCase() === 'input' ||
            e.target.tagName.toLowerCase() === 'button') {
            return;
        }

        isDragging = true;
        initialX = e.clientX - window.offsetLeft;
        initialY = e.clientY - window.offsetTop;
    });

    document.addEventListener('mousemove', e => {
        if (!isDragging) return;
        
        e.preventDefault();
        currentX = e.clientX - initialX;
        currentY = e.clientY - initialY;

        window.style.left = `${currentX}px`;
        window.style.top = `${currentY}px`;
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
    });
}

function getCalibrationDataFromTable() {
    const rows = document.querySelectorAll('#calibration-table tbody tr');
    return Array.from(rows).map(row => {
        const cells = row.cells;
        const stationName = cells[0].textContent;
        const stationPath = getSelectedDirectories().find(dir => path.basename(dir) === stationName);

        return {
            station: stationName,
            fullPath: stationPath,
            waveform: cells[1].querySelector('select').value,
            frequency: parseFloat(cells[2].querySelector('input').value),
            tx: path.join(stationPath, cells[3].querySelector('select').value),
            rx: path.join(stationPath, cells[4].querySelector('select').value),
            coil: cells[5].querySelector('select').value
        };
    });
}

function runCalibration(calibrationData) {
    const progressBar = document.getElementById('calibration-progress-bar');
    const statusLabel = document.getElementById('calibration-status');
    
    progressBar.style.width = '0%';
    statusLabel.textContent = 'Starting calibration...';

    console.log('Sending calibration data to backend:', calibrationData);

    if (ws) {
        ws.send(JSON.stringify({
            type: 'calibrate',
            data: calibrationData.map(item => ({
                station: item.station,
                fullPath: item.fullPath,
                waveform: item.waveform,
                frequency: parseFloat(item.frequency),
                tx: item.tx,
                rx: item.rx,
                coil: item.coil
            }))
        }));
    }
}

function updateCalibrationProgress(progress) {
    const progressBar = document.getElementById('calibration-progress-bar');
    const statusLabel = document.getElementById('calibration-status');
    
    progressBar.style.width = `${progress}%`;
    statusLabel.textContent = `Progress: ${progress}%`;
}

function handleCalibrationResults(results) {
    calibrationResults = results;
    const statusLabel = document.getElementById('calibration-status');
    statusLabel.textContent = 'Calibration completed successfully!';
    
    // Enable export button only after successful calibration
    const exportButton = document.getElementById('export-results');
    if (exportButton) {
        exportButton.textContent = 'Export Results';
        exportButton.disabled = false;
    }

    // Create plots with the results
    createCalibrationPlots(results);
}

function createCalibrationPlots(results) {
    // Create amplitude and phase plots with horizontal layout
    const plotContainer = document.getElementById('plot-container');
    plotContainer.innerHTML = `
        <div style="display: flex; flex-direction: column; width: 100%; height: 100%;">
            <div id="amplitude-plot" class="plot" style="flex: 1; min-height: 0;"></div>
            <div id="phase-plot" class="plot" style="flex: 1; min-height: 0;"></div>
        </div>
    `;

    // Create traces for amplitude plot with different colors
    const amplitudeTraces = Object.entries(results).map(([coil, data], index) => ({
        x: data.Frequencies,
        y: data.Amplitudes,
        type: 'scatter',
        mode: 'lines+markers',
        name: coil,
        line: {
            color: `hsl(${(index * 360) / Object.keys(results).length}, 70%, 50%)`
        },
        marker: {
            color: `hsl(${(index * 360) / Object.keys(results).length}, 70%, 50%)`
        }
    }));

    // Create traces for phase plot with matching colors
    const phaseTraces = Object.entries(results).map(([coil, data], index) => ({
        x: data.Frequencies,
        y: data.Phases,
        type: 'scatter',
        mode: 'lines+markers',
        name: coil,
        line: {
            color: `hsl(${(index * 360) / Object.keys(results).length}, 70%, 50%)`
        },
        marker: {
            color: `hsl(${(index * 360) / Object.keys(results).length}, 70%, 50%)`
        }
    }));

    // Common layout settings
    const commonLayout = {
        xaxis: { 
            type: 'log', 
            title: 'Frequency (Hz)',
            automargin: true
        },
        yaxis: {
            automargin: true
        },
        margin: { l: 50, r: 50, b: 50, t: 50 },
        showlegend: true,
        legend: {
            x: 1,
            xanchor: 'right',
            y: 1
        },
        autosize: true  // Enable auto-sizing
    };

    // Plot configurations
    const config = {
        responsive: true,  // Make the plot responsive
        displayModeBar: true,
        modeBarButtonsToRemove: ['lasso2d', 'select2d'],
        displaylogo: false
    };

    // Create the plots
    Plotly.newPlot('amplitude-plot', amplitudeTraces, {
        ...commonLayout,
        title: 'Amplitude vs Frequency',
        yaxis: { 
            ...commonLayout.yaxis,
            title: 'Amplitude (dB)' 
        }
    }, config);

    Plotly.newPlot('phase-plot', phaseTraces, {
        ...commonLayout,
        title: 'Phase vs Frequency',
        yaxis: { 
            ...commonLayout.yaxis,
            title: 'Phase (degrees)' 
        }
    }, config);

    // Add window resize handler
    window.addEventListener('resize', () => {
        Plotly.Plots.resize('amplitude-plot');
        Plotly.Plots.resize('phase-plot');
    });
}

// Add these functions
function exportResultsToCSV() {
    console.log("Attempting to export results");

    if (!calibrationResults || typeof calibrationResults !== 'object' || Object.keys(calibrationResults).length === 0) {
        console.error("No valid calibration results to export");
        alert('No valid calibration results to export. Please run a calibration first.');
        return;
    }

    // Get current date for filenames
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // Format: YYYY-MM-DD

    let csvContent;
    try {
        csvContent = createCSVContent(calibrationResults);
    } catch (error) {
        console.error("Error creating CSV content:", error);
        alert(`Error creating CSV content: ${error.message}`);
        return;
    }

    if (!csvContent) {
        console.error("CSV content is empty");
        alert("No data to export. Please run calibration again.");
        return;
    }

    // Show save dialog for CSV
    dialog.showSaveDialog({
        title: 'Export Results',
        defaultPath: `calibration_results_${dateStr}.csv`,
        filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    }).then(async result => {
        if (!result.canceled && result.filePath) {
            const directory = path.dirname(result.filePath);
            const baseFilename = path.basename(result.filePath, '.csv');

            try {
                // Save CSV file
                await fs.writeFile(result.filePath, csvContent);

                // Save amplitude plot
                const amplitudePlot = document.getElementById('amplitude-plot');
                await Plotly.toImage(amplitudePlot, {format: 'png', width: 1200, height: 800})
                    .then(url => {
                        // Convert base64 to buffer
                        const base64Data = url.replace(/^data:image\/png;base64,/, "");
                        return fs.writeFile(
                            path.join(directory, `amplitude_plot_${dateStr}.png`),
                            base64Data,
                            'base64'
                        );
                    });

                // Save phase plot
                const phasePlot = document.getElementById('phase-plot');
                await Plotly.toImage(phasePlot, {format: 'png', width: 1200, height: 800})
                    .then(url => {
                        // Convert base64 to buffer
                        const base64Data = url.replace(/^data:image\/png;base64,/, "");
                        return fs.writeFile(
                            path.join(directory, `phase_plot_${dateStr}.png`),
                            base64Data,
                            'base64'
                        );
                    });

                console.log("All files saved successfully");
                alert('Results exported successfully!');
            } catch (err) {
                console.error('Error saving files:', err);
                alert(`Error saving files: ${err.message}`);
            }
        }
    }).catch(err => {
        console.error('Error in export:', err);
        alert(`Error exporting results: ${err.message}`);
    });
}

function createCSVContent(results) {
    console.log("Creating CSV content from:", results);

    const headers = ['Frequency', 'Amplitude', 'Phase', 'Coil'];
    let rows = [headers.join(',')];

    for (const [coil, data] of Object.entries(results)) {
        console.log(`Processing data for coil: ${coil}`, data);

        if (!data || !data.Frequencies || !data.Amplitudes || !data.Phases) {
            console.error(`Invalid or missing data for coil ${coil}`);
            continue;
        }

        const length = Math.min(data.Frequencies.length, data.Amplitudes.length, data.Phases.length);
        
        for (let i = 0; i < length; i++) {
            rows.push(`${data.Frequencies[i]},${data.Amplitudes[i]},${data.Phases[i]},${coil}`);
        }
    }

    if (rows.length === 1) {
        console.error("No valid data to export");
        return null;
    }

    console.log(`CSV content created with ${rows.length} rows`);
    return rows.join('\n');
}

async function importFromConfig() {
    const selectedDirs = getSelectedDirectories();
    if (selectedDirs.length === 0) {
        alert('No folders selected');
        return;
    }

    for (const dir of selectedDirs) {
        try {
            const configPath = path.join(dir, 'config.csv');
            const fileContent = await fs.readFile(configPath, 'utf-8');
            const rows = fileContent.trim().split('\n');
            
            // Parse headers (remove BOM and whitespace)
            const headers = rows[0].toLowerCase().trim()
                .replace(/[\uFEFF\r]/g, '')
                .split(',')
                .map(h => h.trim());

            // Get values from second row
            const values = rows[1].trim().split(',').map(v => v.trim());
            
            // Find the row in calibration table matching this directory
            const dirName = path.basename(dir);
            const tableRows = document.querySelectorAll('#calibration-table tbody tr');
            const matchingRow = Array.from(tableRows).find(row => row.cells[0].textContent === dirName);
            
            if (matchingRow) {
                // Update row values based on config
                const selects = matchingRow.querySelectorAll('select');
                const input = matchingRow.querySelector('input');

                // Map config values to table fields
                const getValue = (field) => {
                    const index = headers.indexOf(field);
                    return index >= 0 ? values[index] : null;
                };

                // Update waveform
                const waveform = getValue('waveform');
                if (waveform) {
                    selects[0].value = waveform.charAt(0).toUpperCase() + waveform.slice(1);
                }

                // Update frequency
                const freq = getValue('freq');
                if (freq) {
                    input.value = parseFloat(freq);
                }

                // Update tx
                const tx = getValue('tx');
                if (tx) {
                    selects[1].value = tx;
                }

                // Update rx
                const rx = getValue('rx');
                if (rx) {
                    selects[2].value = rx;
                }

                // Update coil
                const coil = getValue('coil');
                if (coil) {
                    selects[3].value = `Coil ${coil.slice(-1)}`;
                }
            }
        } catch (error) {
            console.warn(`No config.csv found in ${dir} or error reading it:`, error);
            // Continue with next directory
        }
    }
}

async function importFromConfigFIR() {
    const selectedDirs = getSelectedDirectories();
    if (selectedDirs.length === 0) {
        alert('No folders selected');
        return;
    }

    for (const dir of selectedDirs) {
        try {
            const configPath = path.join(dir, 'config.csv');
            const fileContent = await fs.readFile(configPath, 'utf-8');
            const rows = fileContent.trim().split('\n');
            
            // Parse headers
            const headers = rows[0].toLowerCase().trim()
                .replace(/[\uFEFF\r]/g, '')
                .split(',')
                .map(h => h.trim());

            // Get values
            const values = rows[1].trim().split(',').map(v => v.trim());
            
            // Find matching row in FIR table
            const dirName = path.basename(dir);
            const tableRows = document.querySelectorAll('#fir-table tbody tr');
            const matchingRow = Array.from(tableRows).find(row => row.cells[0].textContent === dirName);
            
            if (matchingRow) {
                const getValue = (field) => {
                    const index = headers.indexOf(field);
                    return index >= 0 ? values[index] : null;
                };

                // Update Coil Name (from name field)
                const name = getValue('name');
                if (name) {
                    matchingRow.querySelector('.coil-name').value = name;
                }

                // Update Base Frequency (from freq field)
                const freq = getValue('freq');
                if (freq) {
                    matchingRow.querySelector('.base-frequency').value = parseFloat(freq);
                }

                // Update Coil Channel (from rx field)
                const rx = getValue('rx');
                if (rx) {
                    matchingRow.querySelector('.coil-channel').value = rx;
                }
            }
        } catch (error) {
            console.warn(`No config.csv found in ${dir} or error reading it:`, error);
            // Continue with next directory
        }
    }
}

// Update the FIR button click handler
document.getElementById('fir').addEventListener('click', () => {
    console.log('FIR button clicked');
    
    // Get selected directories
    const selectedDirs = getSelectedDirectories();
    console.log('Selected directories:', selectedDirs);
    
    if (selectedDirs.length === 0) {
        alert('Please select at least one folder for FIR filter generation.');
        return;
    }

    // First show the window
    showFIRWindow(selectedDirs);

    // Then check for config.csv in each directory
    selectedDirs.forEach(dir => {
        console.log('Checking config for directory:', dir);
        if (ws) {
            ws.send(JSON.stringify({
                type: 'checkConfig',
                path: dir
            }));
        }
    });
});

function showFIRWindow(selectedDirs) {
    console.log('Showing FIR window with directories:', selectedDirs);
    
    const firWindow = document.getElementById('fir-window');
    if (!firWindow) {
        console.error('FIR window element not found!');
        return;
    }

    // Position the window in the center initially
    firWindow.style.position = 'fixed';
    firWindow.style.top = '50%';
    firWindow.style.left = '50%';
    firWindow.style.transform = 'translate(-50%, -50%)';
    firWindow.style.cursor = 'move';

    const firTableBody = document.getElementById('fir-items');
    if (!firTableBody) {
        console.error('FIR table body not found!');
        return;
    }
    
    firTableBody.innerHTML = '';

    // Create a row for each selected directory
    selectedDirs.forEach(dir => {
        const dirName = path.basename(dir);
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${dirName}</td>
            <td><input type="text" class="coil-name"></td>
            <td><input type="number" class="base-frequency" step="any"></td>
            <td><input type="number" class="sample-rate" value="51200" step="any"></td>
            <td>
                <select class="coil-channel">
                    <option value="channel1.bin">channel1.bin</option>
                    <option value="channel2.bin">channel2.bin</option>
                    <option value="channel3.bin">channel3.bin</option>
                </select>
            </td>
        `;
        firTableBody.appendChild(row);
    });

    // Add event listeners for buttons
    const calculateButton = document.getElementById('calculate-fir');
    const closeButton = document.getElementById('close-fir');
    
    // Remove old event listeners
    calculateButton.replaceWith(calculateButton.cloneNode(true));
    closeButton.replaceWith(closeButton.cloneNode(true));
    
    // Add new event listeners
    document.getElementById('calculate-fir').addEventListener('click', () => {
        console.log('Calculate FIR clicked');
        const firData = getFIRDataFromTable();
        console.log('FIR data:', firData);
        calculateFIR(firData);
    });

    document.getElementById('close-fir').addEventListener('click', () => {
        firWindow.style.display = 'none';
        // Clear stored data
        configData.clear();
        configResolvers.clear();
    });

    // Show the window
    firWindow.style.display = 'block';
    console.log('FIR window should now be visible');

    // Make the window draggable
    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;

    firWindow.addEventListener('mousedown', e => {
        if (e.target.tagName.toLowerCase() === 'input' || 
            e.target.tagName.toLowerCase() === 'select' || 
            e.target.tagName.toLowerCase() === 'button') {
            return;
        }

        isDragging = true;
        initialX = e.clientX - firWindow.offsetLeft;
        initialY = e.clientY - firWindow.offsetTop;
    });

    document.addEventListener('mousemove', e => {
        if (!isDragging) return;
        
        e.preventDefault();
        currentX = e.clientX - initialX;
        currentY = e.clientY - initialY;

        firWindow.style.left = `${currentX}px`;
        firWindow.style.top = `${currentY}px`;
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
    });

    // Add import from config button listener
    document.getElementById('import-from-config-fir').addEventListener('click', importFromConfigFIR);
}

function getFIRDataFromTable() {
    const rows = document.querySelectorAll('#fir-table tbody tr');
    return Array.from(rows).map(row => {
        const dirName = row.cells[0].textContent;
        const dirPath = getSelectedDirectories().find(dir => path.basename(dir) === dirName);

        return {
            station: dirName,
            fullPath: dirPath,
            coilName: row.querySelector('.coil-name').value,
            baseFrequency: parseFloat(row.querySelector('.base-frequency').value),
            sampleRate: parseFloat(row.querySelector('.sample-rate').value),
            coilChannel: row.querySelector('.coil-channel').value
        };
    });
}

function calculateFIR(firData) {
    console.log('Calculating FIR with data:', firData);
    if (ws) {
        ws.send(JSON.stringify({
            type: 'calculateFIR',
            data: firData
        }));
    }
}

// Update the WebSocket message handler
ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    console.log('Received from Go backend:', data);
    
    switch (data.type) {
        // ... existing cases ...
        case 'configData':
            console.log('Received config data:', data);
            // Store the config data
            configData.set(data.station, data.config);
            // Update the FIR table if it exists
            updateFIRTableWithConfig(data.station, data.config);
            // Resolve the promise for this station
            const resolver = configResolvers.get(data.station);
            if (resolver) {
                resolver(data.config);
                configResolvers.delete(data.station);
            }
            break;
        case 'firProgress':
            updateFIRProgress(data.station, data.progress);
            break;
        case 'firComplete':
            handleFIRComplete(data.station, data.results);
            // After all FIR calculations are complete, show status
            const statusDiv = document.getElementById('fir-status');
            statusDiv.innerHTML = `<span style="color: #14b8a6;">✓ FIR calculations completed successfully!</span>`;
            break;
    }
};

function updateFIRTableWithConfig(station, config) {
    console.log('Updating FIR table with config:', config);  // Debug log
    const rows = document.querySelectorAll('#fir-table tbody tr');
    const row = Array.from(rows).find(row => row.cells[0].textContent === station);
    
    if (row && config) {
        // Update Coil Name
        const coilNameInput = row.querySelector('.coil-name');
        if (coilNameInput && config.coilName) {
            console.log('Setting coil name to:', config.coilName);
            coilNameInput.value = config.coilName;
        }

        // Update Base Frequency
        const baseFreqInput = row.querySelector('.base-frequency');
        if (baseFreqInput && config.baseFrequency) {
            console.log('Setting base frequency to:', config.baseFrequency);
            baseFreqInput.value = config.baseFrequency;
        }

        // Update Sample Rate
        const sampleRateInput = row.querySelector('.sample-rate');
        if (sampleRateInput && config.sampleRate) {
            console.log('Setting sample rate to:', config.sampleRate);
            sampleRateInput.value = config.sampleRate;
        }

        // Update Coil Channel
        const channelSelect = row.querySelector('.coil-channel');
        if (channelSelect && config.coilChannel) {
            console.log('Setting coil channel to:', `channel${config.coilChannel}.bin`);
            channelSelect.value = `channel${config.coilChannel}.bin`;
        }

        console.log('Row updated:', row);  // Debug log
    } else {
        console.log('Row or config not found:', { row, config });  // Debug log
    }
}

function updateFIRProgress(station, progress) {
    const progressBar = document.getElementById('fir-progress-bar');
    const statusDiv = document.getElementById('fir-status');
    if (progressBar) progressBar.style.width = `${progress}%`;
    if (statusDiv) statusDiv.textContent = `Processing ${station}: ${progress}%`;
}

function handleFIRComplete(station, results) {
    const statusDiv = document.getElementById('fir-status');
    const progressBar = document.getElementById('fir-progress-bar');
    const firWindow = document.getElementById('fir-window');
    
    if (progressBar) progressBar.style.width = '100%';
    if (statusDiv) {
        statusDiv.innerHTML = `<span style="color: #14b8a6;">✓ FIR calculation completed successfully!</span>`;
    }
    
    // Show completion alert with file locations
    const message = `FIR calculation completed successfully!\n\n` +
                   `Results saved in: ${results.OutputDir}\n\n` +
                   `Files generated:\n` +
                   `- fir_coefficients_${results.Timestamp}.csv\n` +
                   `- stacked_coil_waveform_${results.Timestamp}.png\n` +
                   `- filtered_signal_${results.Timestamp}.png`;
    
    alert(message);

    // Auto-close the FIR window after showing the alert
    if (firWindow) {
        firWindow.style.display = 'none';
    }
}

// Add cleanup function
function cleanup() {
    // Clear maps
    configData.clear();
    configResolvers.clear();
    checkedPaths.clear();
    selectedItems = [];
    
    // Clear plots
    const plotContainer = document.getElementById('plot-container');
    if (plotContainer) {
        plotContainer.innerHTML = '<div id="timeseries-plot" class="plot"></div>';
    }
    
    // Clear WebSocket
    if (ws) {
        ws.close();
        ws = null;
    }
}

// Add window unload handler
window.addEventListener('unload', cleanup);

// Add debouncing for window resize
const debounce = (func, wait) => {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
};

// Use more efficient event listeners
window.addEventListener('resize', debounce(() => {
    const plot = document.getElementById('timeseries-plot');
    if (plot) {
        Plotly.Plots.resize(plot);
    }
}, 250), { passive: true });

// Use passive event listeners where possible
plot.addEventListener('wheel', function(event) {
    // ... existing wheel zoom code ...
}, { passive: false });