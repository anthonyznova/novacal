package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gorilla/mux"
	"nova-toolkit/backend/calibration"
	"nova-toolkit/backend/timeseries"
)

type ListItemsResponse struct {
	Items []ListItem `json:"items"`
}

type ListItem struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	IsDir    bool   `json:"isDir"`
	Selected bool   `json:"selected"`
}

type CalibrationRequest struct {
	Data        []CalibrationData `json:"data"`
	CurrentPath string            `json:"currentPath"`
}

type CalibrationResult struct {
	Frequencies []float64 `json:"Frequencies"`
	Amplitudes  []float64 `json:"Amplitudes"`
	Phases      []float64 `json:"Phases"`
}

type CalibrationData struct {
	Station   string  `json:"station"`
	FullPath  string  `json:"fullPath"`
	Waveform  string  `json:"waveform"`
	Frequency float64 `json:"frequency"`
	Tx        string  `json:"tx"`
	Rx        string  `json:"rx"`
	Coil      string  `json:"coil"`
}

type CalibrationResponse struct {
	Frequencies []float64 `json:"frequencies"`
	Amplitudes  []float64 `json:"amplitudes"`
	Phases      []float64 `json:"phases"`
}

type PlotTimeseriesRequest struct {
	FilePaths        []string `json:"filePaths"`
	StartIndex       int      `json:"startIndex"`
	EndIndex         int      `json:"endIndex"`
	DecimationFactor int      `json:"decimationFactor"`
}

type PlotTimeseriesResponse struct {
	Times  []float64 `json:"times"`
	Values []float64 `json:"values"`
}

type GetFileLengthsRequest struct {
	FilePaths []string `json:"filePaths"`
}

type GetFileLengthsResponse struct {
	TotalLength int64 `json:"totalLength"`
}

var progressChan = make(chan int)

func main() {
	r := mux.NewRouter()
	r.HandleFunc("/list-items", handleListItems).Methods("GET")
	r.HandleFunc("/calibrate", handleCalibrate).Methods("POST")
	r.HandleFunc("/calibrate-progress", handleCalibrateProgress).Methods("GET")
	r.HandleFunc("/plot-timeseries", handlePlotTimeseries).Methods("POST")
	r.HandleFunc("/get-file-lengths", handleGetFileLengths).Methods("POST")
	r.PathPrefix("/plots/").Handler(http.StripPrefix("/plots/", http.FileServer(http.Dir("plots"))))
	r.HandleFunc("/calibrate-progress", handleCalibrateProgress).Methods("GET")

	// Enable CORS
	corsMiddleware := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			if r.Method == "OPTIONS" {
				return
			}
			next.ServeHTTP(w, r)
		})
	}

	log.Println("Server starting on http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", corsMiddleware(r)))
}

func handleListItems(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, "Path parameter is required", http.StatusBadRequest)
		return
	}

	items, err := listItems(path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	response := ListItemsResponse{Items: items}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func listItems(path string) ([]ListItem, error) {
	files, err := os.ReadDir(path)
	if err != nil {
		return nil, fmt.Errorf("error reading directory: %v", err)
	}

	var items []ListItem

	// Add parent directory option if not at root
	if filepath.Dir(path) != path {
		items = append(items, ListItem{Name: "..", Path: filepath.Dir(path), IsDir: true})
	}

	for _, file := range files {
		fullPath := filepath.Join(path, file.Name())
		if file.IsDir() {
			items = append(items, ListItem{Name: file.Name(), Path: fullPath, IsDir: true})
		} else if filepath.Ext(file.Name()) == ".bin" {
			items = append(items, ListItem{Name: file.Name(), Path: fullPath, IsDir: false})
		}
	}

	return items, nil
}

func handleCalibrate(w http.ResponseWriter, r *http.Request) {
	var req CalibrationRequest
	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	log.Printf("Received calibration data: %+v", req.Data)

	sineFilePaths := make(map[string]map[float64]map[string]string)
	squareFilePaths := make(map[string]map[float64]map[string]string)

	for _, item := range req.Data {
		paths := map[string]string{
			"tx": item.Tx,
			"rx": item.Rx,
		}
		log.Printf("Using paths for %s: tx=%s, rx=%s", item.Station, paths["tx"], paths["rx"])

		if _, ok := sineFilePaths[item.Coil]; !ok {
			sineFilePaths[item.Coil] = make(map[float64]map[string]string)
		}
		if _, ok := squareFilePaths[item.Coil]; !ok {
			squareFilePaths[item.Coil] = make(map[float64]map[string]string)
		}
		if item.Waveform == "Sine" {
			sineFilePaths[item.Coil][item.Frequency] = paths
		} else {
			squareFilePaths[item.Coil][item.Frequency] = paths
		}
	}

	results, err := calibration.RunCalibration(sineFilePaths, squareFilePaths, func(progress int) {
		select {
		case progressChan <- progress:
		default:
		}
	})

	if err != nil {
		log.Printf("Calibration error: %v", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	log.Printf("Calibration completed, sending results")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(results)
}

func handleCalibrateProgress(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported!", http.StatusInternalServerError)
		return
	}

	for {
		select {
		case progress := <-progressChan:
			fmt.Fprintf(w, "data: %d\n\n", progress)
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func handlePlotTimeseries(w http.ResponseWriter, r *http.Request) {
	var req PlotTimeseriesRequest
	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	times, values, err := timeseries.ReadAndDownsample(req.FilePaths, req.StartIndex, req.EndIndex, req.DecimationFactor)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	response := PlotTimeseriesResponse{
		Times:  times,
		Values: values,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func handleGetFileLengths(w http.ResponseWriter, r *http.Request) {
	var req GetFileLengthsRequest
	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	totalLength, err := timeseries.GetTotalFileLength(req.FilePaths)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	response := GetFileLengthsResponse{
		TotalLength: totalLength,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}
