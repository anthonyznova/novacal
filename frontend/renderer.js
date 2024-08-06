const { dialog } = require('@electron/remote')
const fs = require('fs')
const path = require('path')
const { ipcRenderer } = require('electron');

ipcRenderer.on('backend-status', (event, status) => {
  console.log('Backend status:', status);
  if (status !== 'running') {
    alert('The backend is not running. Some features may not work correctly.');
  }
});
let currentPath = ''
let selectedItems = []
let calibrationResults = null;
let selectedFolderPaths = new Map(); // Declare this at the top of your file

document.getElementById('select-folder').addEventListener('click', () => {
    dialog.showOpenDialog({
        properties: ['openDirectory']
    }).then(result => {
        if (!result.canceled) {
            currentPath = result.filePaths[0]
            loadItems(currentPath)
        }
    }).catch(err => {
        console.log(err)
    })
})

document.getElementById('import-settings').addEventListener('click', importSettings);

document.getElementById('calibrate').addEventListener('click', () => {
    const calibrationItems = selectedItems.filter(item => item.isDir).map(item => ({
        station: item.name,
        waveform: 'Square',
        frequency: 0,
        tx: 'channel2.bin',
        rx: 'channel1.bin',
        coil: 'Coil 1'
    }))
    showCalibrationWindow(calibrationItems)
})

document.getElementById('plot').addEventListener('click', () => {
    const selectedFiles = selectedItems.filter(item => !item.isDir)
    if (selectedFiles.length === 0) {
        alert('Please select at least one .bin file to plot.')
        return
    }
    plotTimeseries(selectedFiles.map(item => item.path))
})

document.getElementById('uncheck-all').addEventListener('click', () => {
    const checkboxes = document.querySelectorAll('.item-checkbox');
    checkboxes.forEach(checkbox => {
        checkbox.checked = false;
    });
    selectedItems = [];
    selectedFolderPaths.clear();
    updateCalibrationTable();
    console.log('All items unchecked');
});

function updateSelectedItems(item, isSelected) {
    if (isSelected) {
        if (!selectedItems.some(selectedItem => selectedItem.path === item.path)) {
            selectedItems.push(item);
            selectedFolderPaths.set(item.name, item.path);
        }
    } else {
        selectedItems = selectedItems.filter(selectedItem => selectedItem.path !== item.path);
        selectedFolderPaths.delete(item.name);
    }
    updateCalibrationTable();
    console.log('Selected items:', selectedItems);
}


document.getElementById('clear-plots').addEventListener('click', clearPlots)

function loadItems(path) {
    fetch(`http://localhost:8080/list-items?path=${encodeURIComponent(path)}`)
        .then(response => response.json())
        .then(data => {
            updateItemList(data.items)
        })
        .catch(error => console.error('Error:', error))
}

function updateItemList(items) {
    const itemList = document.getElementById('item-list')
    itemList.innerHTML = ''
    items.forEach(item => {
        const itemElement = document.createElement('div')
        itemElement.className = 'list-item'

        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.className = 'item-checkbox'
        checkbox.checked = selectedItems.some(selectedItem => selectedItem.path === item.path)
        checkbox.addEventListener('change', (event) => {
            event.stopPropagation()
            updateSelectedItems(item, checkbox.checked)
        })

        const label = document.createElement('span')
        label.textContent = item.name
        label.style.cursor = item.isDir ? 'pointer' : 'default'

        const itemContent = document.createElement('div')
        itemContent.style.display = 'flex'
        itemContent.style.alignItems = 'center'
        itemContent.appendChild(checkbox)
        itemContent.appendChild(label)

        itemElement.appendChild(itemContent)

        if (item.isDir) {
            label.addEventListener('click', (event) => {
                event.stopPropagation()
                currentPath = item.path
                loadItems(currentPath)
            })
        }

        itemList.appendChild(itemElement)
    })
}

function updateSelectedItems(item, isSelected) {
    if (isSelected) {
        if (!selectedItems.some(selectedItem => selectedItem.path === item.path)) {
            selectedItems.push(item);
            selectedFolderPaths.set(item.name, item.path);
        }
    } else {
        selectedItems = selectedItems.filter(selectedItem => selectedItem.path !== item.path);
        selectedFolderPaths.delete(item.name);
    }
    updateCalibrationTable();
}


function updateCalibrationTable(data) {
    const tableBody = document.getElementById('calibration-items');
    const existingRows = Array.from(tableBody.querySelectorAll('tr'));
    
    data.forEach((row, index) => {
        let tr;
        if (index < existingRows.length) {
            tr = existingRows[index];
        } else {
            tr = document.createElement('tr');
            tableBody.appendChild(tr);
        }
        
        // Keep the existing station name
        const stationName = tr.cells[0] ? tr.cells[0].textContent : '';
        
        tr.innerHTML = `
            <td>${stationName}</td>
            <td>
                <select>
                    <option value="Square" ${row.waveform === 'Square' ? 'selected' : ''}>Square</option>
                    <option value="Sine" ${row.waveform === 'Sine' ? 'selected' : ''}>Sine</option>
                </select>
            </td>
            <td><input type="number" value="${row.freq || ''}"></td>
            <td>
                <select>
                    <option value="channel1.bin" ${row.tx === 'channel1.bin' ? 'selected' : ''}>channel1.bin</option>
                    <option value="channel2.bin" ${row.tx === 'channel2.bin' ? 'selected' : ''}>channel2.bin</option>
                    <option value="channel3.bin" ${row.tx === 'channel3.bin' ? 'selected' : ''}>channel3.bin</option>
                </select>
            </td>
            <td>
                <select>
                    <option value="channel1.bin" ${row.rx === 'channel1.bin' ? 'selected' : ''}>channel1.bin</option>
                    <option value="channel2.bin" ${row.rx === 'channel2.bin' ? 'selected' : ''}>channel2.bin</option>
                    <option value="channel3.bin" ${row.rx === 'channel3.bin' ? 'selected' : ''}>channel3.bin</option>
                </select>
            </td>
            <td>
                <select>
                    <option value="Coil 1" ${row.coil === 'coil1' ? 'selected' : ''}>Coil 1</option>
                    <option value="Coil 2" ${row.coil === 'coil2' ? 'selected' : ''}>Coil 2</option>
                    <option value="Coil 3" ${row.coil === 'coil3' ? 'selected' : ''}>Coil 3</option>
                </select>
            </td>
        `;
    });

    // Remove any excess rows
    while (tableBody.children.length > data.length) {
        tableBody.removeChild(tableBody.lastChild);
    }
}

function showCalibrationWindow(calibrationItems) {
    const calibrationWindow = document.getElementById('calibration-window');
    calibrationWindow.style.display = 'block';
    
    const calibrationTableBody = document.getElementById('calibration-items');
    calibrationTableBody.innerHTML = '';
    calibrationTableBody.appendChild(createCalibrationTable(calibrationItems));

    const progressBar = document.getElementById('calibration-progress-bar');
    progressBar.style.width = '0%';

    const statusLabel = document.getElementById('calibration-status');
    statusLabel.textContent = '';

    const runButton = document.getElementById('run-calibration');
    runButton.onclick = () => runCalibration(getCalibrationItemsFromTable(), progressBar, statusLabel);

    const exportButton = document.getElementById('export-results');
    exportButton.disabled = true;
    exportButton.onclick = exportResultsToCSV;

    const closeButton = document.getElementById('close-calibration');
    closeButton.onclick = () => {
        calibrationWindow.style.display = 'none';
        // Remove any previously added results summary
        const resultsDiv = calibrationWindow.querySelector('div:last-child');
        if (resultsDiv && resultsDiv.querySelector('h3')) {
            calibrationWindow.removeChild(resultsDiv);
        }
    };

    // Add resize functionality
    const resizeHandles = calibrationWindow.querySelectorAll('.resizable-handle');
    resizeHandles.forEach(handle => {
        handle.addEventListener('mousedown', initResize);
    });
}

function initResize(e) {
    e.preventDefault();
    const calibrationWindow = document.getElementById('calibration-window');
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = parseInt(getComputedStyle(calibrationWindow).width, 10);
    const startHeight = parseInt(getComputedStyle(calibrationWindow).height, 10);
    const handleClass = e.target.className.split(' ')[1]; // top-left, top-right, bottom-left, bottom-right

    document.addEventListener('mousemove', resize);
    document.addEventListener('mouseup', stopResize);

    function resize(e) {
        const newWidth = startWidth + (e.clientX - startX) * (handleClass.includes('right') ? 1 : -1);
        const newHeight = startHeight + (e.clientY - startY) * (handleClass.includes('bottom') ? 1 : -1);

        if (newWidth > 300 && newHeight > 200) {
            calibrationWindow.style.width = newWidth + 'px';
            calibrationWindow.style.height = newHeight + 'px';
        }
    }

    function stopResize() {
        document.removeEventListener('mousemove', resize);
        document.removeEventListener('mouseup', stopResize);
    }
}

// Make sure to call this function when the page loads
function addResizeListeners() {
    const calibrationWindow = document.getElementById('calibration-window');
    const resizeHandles = calibrationWindow.querySelectorAll('.resizable-handle');
    resizeHandles.forEach(handle => {
        handle.addEventListener('mousedown', initResize);
    });
}

// Call this function when the page loads
document.addEventListener('DOMContentLoaded', addResizeListeners);
function exportResultsToCSV() {
    console.log("Attempting to export results to CSV");
    console.log("calibrationResults:", JSON.stringify(calibrationResults, null, 2));

    if (!calibrationResults || typeof calibrationResults !== 'object' || Object.keys(calibrationResults).length === 0) {
        console.error("No valid calibration results to export");
        alert('No valid calibration results to export. Please run a calibration first.');
        return;
    }

    const { dialog } = require('@electron/remote');
    const fs = require('fs').promises;

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

    dialog.showSaveDialog({
        title: 'Export Calibration Results',
        defaultPath: 'calibration_results.csv',
        filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    }).then(result => {
        if (!result.canceled && result.filePath) {
            console.log("Saving file to:", result.filePath);
            return fs.writeFile(result.filePath, csvContent);
        } else {
            console.log("File save dialog was canceled");
        }
    }).then(() => {
        if (csvContent) {
            console.log("File saved successfully");
            alert('Results exported successfully!');
        }
    }).catch(err => {
        console.error('Error in CSV export:', err);
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

function createCalibrationTable(items) {
    const fragment = document.createDocumentFragment();
    items.forEach(item => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${item.station}</td>
            <td>
                <select>
                    <option value="Square" ${item.waveform === 'Square' ? 'selected' : ''}>Square</option>
                    <option value="Sine" ${item.waveform === 'Sine' ? 'selected' : ''}>Sine</option>
                </select>
            </td>
            <td><input type="number" value="${item.frequency}"></td>
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
        fragment.appendChild(row);
    });
    return fragment;
}

function getCalibrationItemsFromTable() {
    const rows = document.querySelectorAll('#calibration-table tbody tr');
    const items = Array.from(rows).map(row => {
        const cells = row.querySelectorAll('td');
        const stationName = cells[0].textContent.trim();
        const fullPath = selectedFolderPaths.get(stationName);

        if (!fullPath) {
            console.warn(`Full path not found for station: ${stationName}`);
            return null;
        }

        const txFile = cells[3].querySelector('select').value;
        const rxFile = cells[4].querySelector('select').value;

        return {
            station: stationName,
            fullPath: fullPath,
            waveform: cells[1].querySelector('select').value,
            frequency: parseFloat(cells[2].querySelector('input').value),
            tx: `${fullPath}\\${txFile}`,
            rx: `${fullPath}\\${rxFile}`,
            coil: cells[5].querySelector('select').value
        };
    }).filter(item => item !== null);

    console.log("All calibration items:", items);
    return items;
}

function runCalibration(calibrationItems, progressBar, statusLabel) {
    // Set initial status
    statusLabel.textContent = 'Starting calibration...';
    progressBar.style.width = '0%';

    const eventSource = new EventSource('http://localhost:8080/calibrate-progress');
    
    eventSource.onmessage = function(event) {
        const progress = parseInt(event.data);
        progressBar.style.width = `${progress}%`;
        statusLabel.textContent = `Progress: ${progress}%`;
        console.log(`Progress update received: ${progress}%`);
    }

    eventSource.onerror = function(error) {
        console.error("EventSource failed:", error);
        eventSource.close();
    }

    const requestData = {
        data: calibrationItems,
        currentPath: currentPath
    };

    console.log("Sending calibration data:", requestData);

    fetch('http://localhost:8080/calibrate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestData)
    })
    .then(response => {
        if (!response.ok) {
            return response.text().then(text => { throw new Error(text) });
        }
        return response.json();
    })
    .then(data => {
        console.log("Received calibration data:", JSON.stringify(data, null, 2));
        eventSource.close();
        calibrationResults = data;
        console.log("Set calibrationResults to:", JSON.stringify(calibrationResults, null, 2));
        createPlots(data);
        updateCalibrationWindowWithResults(data);
        statusLabel.textContent = 'Calibration completed successfully!';
        statusLabel.style.color = 'green';
        updateExportButton();  // Enable the export button
    })
    .catch(error => {
        console.error('Error:', error);
        eventSource.close();
        statusLabel.textContent = `Calibration failed: ${error.message}`;
        statusLabel.style.color = 'red';
        progressBar.style.backgroundColor = 'red';
    });
}

function updateCalibrationWindowWithResults(results) {
    console.log("Updating calibration window with results:", results);
    try {
        const statusLabel = document.getElementById('calibration-status');
        statusLabel.textContent = 'Calibration completed successfully!';

        const exportButton = document.getElementById('export-results');
        exportButton.disabled = false;

        // Optionally, you can display a summary of the results in the calibration window
        const resultsDiv = document.createElement('div');
        resultsDiv.innerHTML = `
            <h3>Calibration Results Summary</h3>
        `;

        for (const [coil, data] of Object.entries(results)) {
            if (data && Array.isArray(data.Frequencies)) {
                resultsDiv.innerHTML += `
                    <p>${coil}:</p>
                    <p>Number of data points: ${data.Frequencies.length}</p>
                    <p>Frequency range: ${Math.min(...data.Frequencies).toFixed(2)} Hz - ${Math.max(...data.Frequencies).toFixed(2)} Hz</p>
                `;
            } else {
                console.error(`Invalid data for coil ${coil}:`, data);
            }
        }

        const calibrationWindow = document.getElementById('calibration-window');
        const existingResultsDiv = calibrationWindow.querySelector('div:last-child');
        if (existingResultsDiv && existingResultsDiv.querySelector('h3')) {
            calibrationWindow.removeChild(existingResultsDiv);
        }
        calibrationWindow.appendChild(resultsDiv);
    } catch (error) {
        console.error("Error in updateCalibrationWindowWithResults:", error);
        throw error; // Re-throw the error to be caught in runCalibration
    }
}

function updateExportButton() {
    const exportButton = document.getElementById('export-results');
    if (exportButton) {
        exportButton.disabled = !calibrationResults || Object.keys(calibrationResults).length === 0;
    }
}

function plotTimeseries(filePaths) {
    const plotContainer = document.getElementById('plot-container')
    plotContainer.innerHTML = '<div id="timeseries-plot" style="width:100%;height:600px;"></div>'

    const layout = {
        title: 'Time Series Plot',
        xaxis: { title: 'Time (s)' },
        yaxis: { title: 'Value' },
    }

    Plotly.newPlot('timeseries-plot', [], layout)

    const SAMPLE_RATE = 51200
    const MAX_POINTS = 50000 // Increased maximum number of points
    let totalLength = 0

    function updatePlot(startTime, endTime) {
        const startIndex = Math.floor(startTime * SAMPLE_RATE)
        const endIndex = Math.ceil(endTime * SAMPLE_RATE)
        const totalPoints = endIndex - startIndex
        const decimationFactor = Math.max(1, Math.floor(totalPoints / MAX_POINTS))

        fetch('http://localhost:8080/plot-timeseries', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                filePaths: filePaths,
                startIndex: startIndex,
                endIndex: endIndex,
                decimationFactor: decimationFactor
            })
        })
        .then(response => response.json())
        .then(data => {
            const traces = filePaths.map((_, i) => {
                const start = i * data.times.length / filePaths.length
                const end = (i + 1) * data.times.length / filePaths.length
                return {
                    x: data.times.slice(start, end).map(t => t / SAMPLE_RATE),
                    y: data.values.slice(start, end),
                    type: 'scattergl',
                    mode: 'lines+markers',
                    name: `File ${i + 1}`,
                    line: { width: 1 },
                    marker: { size: 2 }
                }
            })
            Plotly.react('timeseries-plot', traces, layout)
        })
        .catch(error => console.error('Error:', error))
    }

    // Get the total length of all files
    fetch('http://localhost:8080/get-file-lengths', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ filePaths: filePaths })
    })
    .then(response => response.json())
    .then(data => {
        totalLength = data.totalLength / SAMPLE_RATE
        updatePlot(0, totalLength)
    })
    .catch(error => console.error('Error:', error))

    const plot = document.getElementById('timeseries-plot')
    
    plot.on('plotly_relayout', function(eventdata) {
        if (eventdata['xaxis.range[0]'] !== undefined && eventdata['xaxis.range[1]'] !== undefined) {
            updatePlot(eventdata['xaxis.range[0]'], eventdata['xaxis.range[1]'])
        } else if (eventdata['xaxis.autorange'] === true) {
            // This handles the case when zooming out completely
            updatePlot(0, totalLength)
        }
    })

    plot.addEventListener('wheel', function(event) {
        event.preventDefault()
        const layout = plot.layout
        const xaxis = layout.xaxis
        const yaxis = layout.yaxis

        const mouseX = event.offsetX / plot.clientWidth
        const mouseY = 1 - (event.offsetY / plot.clientHeight)

        const zoomFactor = event.deltaY > 0 ? 0.9 : 1.1

        if (event.ctrlKey) {
            // Vertical zoom
            const ymin = yaxis.range[0]
            const ymax = yaxis.range[1]
            const ycenter = ymin + (ymax - ymin) * mouseY
            const ynewMin = ycenter - (ycenter - ymin) / zoomFactor
            const ynewMax = ycenter + (ymax - ycenter) / zoomFactor
            Plotly.relayout(plot, {'yaxis.range': [ynewMin, ynewMax]})
        } else {
            // Horizontal zoom
            const xmin = xaxis.range[0]
            const xmax = xaxis.range[1]
            const xcenter = xmin + (xmax - xmin) * mouseX
            const xnewMin = xcenter - (xcenter - xmin) / zoomFactor
            const xnewMax = xcenter + (xmax - xcenter) / zoomFactor
            Plotly.relayout(plot, {'xaxis.range': [xnewMin, xnewMax]})
                .then(() => {
                    updatePlot(xnewMin, xnewMax)
                })
        }
    })

    // Add double-click event listener to reset view
    plot.addEventListener('dblclick', function(event) {
        event.preventDefault()
        Plotly.relayout(plot, {
            'xaxis.autorange': true,
            'yaxis.autorange': true
        })
    })
}

function createPlots(data) {
    console.log("Creating plots with data:", data);

    if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
        console.error("Invalid data for plotting:", data);
        return;
    }

    const amplitudeTraces = [];
    const phaseTraces = [];

    for (const [coil, coilData] of Object.entries(data)) {
        if (!coilData || !Array.isArray(coilData.Frequencies) || !Array.isArray(coilData.Amplitudes) || !Array.isArray(coilData.Phases)) {
            console.error(`Invalid data for coil ${coil}:`, coilData);
            continue;
        }

        amplitudeTraces.push({
            x: coilData.Frequencies,
            y: coilData.Amplitudes,
            type: 'scatter',
            mode: 'lines+markers',
            name: `${coil} Amplitude`
        });

        phaseTraces.push({
            x: coilData.Frequencies,
            y: coilData.Phases,
            type: 'scatter',
            mode: 'lines+markers',
            name: `${coil} Phase`
        });
    }

    if (amplitudeTraces.length === 0 || phaseTraces.length === 0) {
        console.error("No valid data for plotting");
        return;
    }

    const layout = {
        autosize: true,
        margin: { l: 50, r: 50, b: 100, t: 50, pad: 4 },
        xaxis: {
            title: 'Frequency (Hz)',
            type: 'log'
        },
        legend: {
            orientation: 'h',
            y: -0.3,
            x: 0.5,
            xanchor: 'center'
        },
        height: window.innerHeight / 2 - 60 // Adjust this value as needed
    };

    const amplitudeLayout = {
        ...layout,
        title: 'Amplitude vs Frequency',
        yaxis: { title: 'Amplitude (dB)' }
    };

    const phaseLayout = {
        ...layout,
        title: 'Phase vs Frequency',
        yaxis: { title: 'Phase (degrees)' }
    };

    Plotly.newPlot('amplitude-plot', amplitudeTraces, amplitudeLayout, {responsive: true});
    Plotly.newPlot('phase-plot', phaseTraces, phaseLayout, {responsive: true});

    window.addEventListener('resize', () => {
        Plotly.Plots.resize('amplitude-plot');
        Plotly.Plots.resize('phase-plot');
    });
}

function importSettings() {
    const { dialog } = require('@electron/remote');
    const fs = require('fs').promises;
    const Papa = require('papaparse');

    dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    }).then(result => {
        if (!result.canceled && result.filePaths.length > 0) {
            return fs.readFile(result.filePaths[0], 'utf-8');
        }
    }).then(fileContent => {
        if (fileContent) {
            Papa.parse(fileContent, {
                header: true,
                complete: function(results) {
                    updateCalibrationTable(results.data);
                }
            });
        }
    }).catch(err => {
        console.error('Error reading CSV file:', err);
        alert(`Error importing settings: ${err.message}`);
    });
}

function clearPlots() {
    const plotContainer = document.getElementById('plot-container');
    plotContainer.innerHTML = `
        <div id="amplitude-plot" class="plot"></div>
        <div id="phase-plot" class="plot"></div>
        <div id="timeseries-plot" class="plot"></div>
    `;
    Plotly.purge('amplitude-plot');
    Plotly.purge('phase-plot');
    Plotly.purge('timeseries-plot');
}
function initLeftContainerResize() {
    const leftContainer = document.getElementById('left-container');
    const resizer = document.getElementById('left-container-resizer');
    let startX, startWidth;

    resizer.addEventListener('mousedown', initDrag, false);

    function initDrag(e) {
        startX = e.clientX;
        startWidth = parseInt(document.defaultView.getComputedStyle(leftContainer).width, 10);
        document.documentElement.addEventListener('mousemove', doDrag, false);
        document.documentElement.addEventListener('mouseup', stopDrag, false);
    }

    function doDrag(e) {
        leftContainer.style.width = (startWidth + e.clientX - startX) + 'px';
    }

    function stopDrag(e) {
        document.documentElement.removeEventListener('mousemove', doDrag, false);
        document.documentElement.removeEventListener('mouseup', stopDrag, false);
    }
}

// Function to launch the app in full screen
function launchFullScreen() {
    const element = document.documentElement;
    if (element.requestFullscreen) {
        element.requestFullscreen();
    } else if (element.mozRequestFullScreen) {
        element.mozRequestFullScreen();
    } else if (element.webkitRequestFullscreen) {
        element.webkitRequestFullscreen();
    } else if (element.msRequestFullscreen) {
        element.msRequestFullscreen();
    }
}

// Initialize the app
function initApp() {
    // Existing initialization code...

    // Add left container resize functionality
    initLeftContainerResize();

    // Launch in full screen
    launchFullScreen();

    updateExportButton();
}

// Call initApp when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', initApp);

// Initial load of root directory
loadItems('/')