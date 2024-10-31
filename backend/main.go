package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"novacal/calibration"
	"novacal/fir"
	"novacal/timeseries"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type Message struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

type DirectoryRequest struct {
	Type string `json:"type"`
	Path string `json:"path"`
}

type FileInfo struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
}

type DirectoryResponse struct {
	Type  string     `json:"type"`
	Files []FileInfo `json:"files"`
}

type PlotRequest struct {
	Type             string   `json:"type"`
	Files            []string `json:"files"`
	StartIndex       int      `json:"startIndex"`
	EndIndex         int      `json:"endIndex"`
	DecimationFactor int      `json:"decimationFactor"`
}

// findAvailablePort tries to find an available port starting from the given port
func findAvailablePort(startPort int) (int, error) {
	for port := startPort; port < startPort+100; port++ {
		addr := fmt.Sprintf(":%d", port)
		listener, err := net.Listen("tcp", addr)
		if err != nil {
			continue
		}
		listener.Close()
		return port, nil
	}
	return 0, fmt.Errorf("no available ports found between %d and %d", startPort, startPort+100)
}

func main() {
	// Try to find an available port starting from 8080
	port, err := findAvailablePort(8080)
	if err != nil {
		log.Fatal("Could not find available port:", err)
	}

	addr := fmt.Sprintf(":%d", port)
	log.Printf("Starting Go backend server on http://localhost%s", addr)

	http.HandleFunc("/ws", handleWebSocket)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatal("Server error:", err)
	}
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}
	defer conn.Close()

	log.Println("New client connected")

	for {
		messageType, message, err := conn.ReadMessage()
		if err != nil {
			log.Println("Read error:", err)
			break
		}

		handleMessage(conn, messageType, message)
	}
}

func handleMessage(conn *websocket.Conn, messageType int, message []byte) {
	var msg struct {
		Type  string   `json:"type"`
		Files []string `json:"files"`
		Path  string   `json:"path"`
	}

	if err := json.Unmarshal(message, &msg); err != nil {
		log.Println("Error parsing message:", err)
		return
	}

	switch msg.Type {
	case "listDirectory":
		files, err := listDirectory(msg.Path)
		if err != nil {
			log.Println("Error listing directory:", err)
			return
		}

		response := DirectoryResponse{
			Type:  "directoryContents",
			Files: files,
		}

		if err := conn.WriteJSON(response); err != nil {
			log.Println("Write error:", err)
		}
	case "plot":
		var plotReq PlotRequest
		if err := json.Unmarshal(message, &plotReq); err != nil {
			conn.WriteJSON(Message{
				Type:    "error",
				Message: "Invalid plot request format",
			})
			return
		}

		if len(plotReq.Files) == 0 {
			conn.WriteJSON(Message{
				Type:    "error",
				Message: "No files selected for plotting",
			})
			return
		}

		// Filter for .bin files
		var binFiles []string
		for _, file := range plotReq.Files {
			if filepath.Ext(file) == ".bin" {
				binFiles = append(binFiles, file)
			}
		}

		if len(binFiles) == 0 {
			conn.WriteJSON(Message{
				Type:    "error",
				Message: "No .bin files selected",
			})
			return
		}

		// If this is the initial plot request (startIndex and endIndex are 0)
		if plotReq.StartIndex == 0 && plotReq.EndIndex == 0 {
			// Get total length first
			totalLength, err := timeseries.GetTotalFileLength(binFiles)
			if err != nil {
				conn.WriteJSON(Message{
					Type:    "error",
					Message: fmt.Sprintf("Error getting file length: %v", err),
				})
				return
			}
			plotReq.EndIndex = int(totalLength)
		}

		// Read and downsample the data
		times, values, err := timeseries.ReadAndDownsample(
			binFiles,
			plotReq.StartIndex,
			plotReq.EndIndex,
			plotReq.DecimationFactor,
		)
		if err != nil {
			conn.WriteJSON(Message{
				Type:    "error",
				Message: fmt.Sprintf("Error reading files: %v", err),
			})
			return
		}

		// Send the plot data back to the client
		plotData := struct {
			Type   string    `json:"type"`
			Times  []float64 `json:"times"`
			Values []float64 `json:"values"`
		}{
			Type:   "plotData",
			Times:  times,
			Values: values,
		}

		if err := conn.WriteJSON(plotData); err != nil {
			log.Println("Error sending plot data:", err)
		}
	case "getTotalLength":
		var lengthReq struct {
			Type  string   `json:"type"`
			Files []string `json:"files"`
		}
		if err := json.Unmarshal(message, &lengthReq); err != nil {
			conn.WriteJSON(Message{
				Type:    "error",
				Message: "Invalid length request format",
			})
			return
		}

		// Validate file paths
		validPaths, err := validateFilePaths(lengthReq.Files)
		if err != nil {
			conn.WriteJSON(Message{
				Type:    "error",
				Message: fmt.Sprintf("Error validating files: %v", err),
			})
			return
		}

		totalLength, err := timeseries.GetTotalFileLength(validPaths)
		if err != nil {
			conn.WriteJSON(Message{
				Type:    "error",
				Message: fmt.Sprintf("Error getting file length: %v", err),
			})
			return
		}

		response := struct {
			Type        string `json:"type"`
			TotalLength int64  `json:"totalLength"`
		}{
			Type:        "totalLength",
			TotalLength: totalLength,
		}

		if err := conn.WriteJSON(response); err != nil {
			log.Println("Write error:", err)
		}
	case "calibrate":
		var calibrationReq struct {
			Type string `json:"type"`
			Data []struct {
				Station   string  `json:"station"`
				FullPath  string  `json:"fullPath"`
				Waveform  string  `json:"waveform"`
				Frequency float64 `json:"frequency"`
				Tx        string  `json:"tx"`
				Rx        string  `json:"rx"`
				Coil      string  `json:"coil"`
			} `json:"data"`
		}

		log.Printf("Received calibration request")

		if err := json.Unmarshal(message, &calibrationReq); err != nil {
			log.Printf("Error unmarshaling calibration request: %v", err)
			conn.WriteJSON(Message{
				Type:    "error",
				Message: "Invalid calibration request format",
			})
			return
		}

		log.Printf("Calibration data: %+v", calibrationReq.Data)

		// Organize data for calibration
		sineFilePaths := make(map[string]map[float64]map[string]string)
		squareFilePaths := make(map[string]map[float64]map[string]string)

		for _, item := range calibrationReq.Data {
			var targetMap map[string]map[float64]map[string]string
			if item.Waveform == "Sine" {
				targetMap = sineFilePaths
			} else {
				targetMap = squareFilePaths
			}

			if _, exists := targetMap[item.Coil]; !exists {
				targetMap[item.Coil] = make(map[float64]map[string]string)
			}
			if _, exists := targetMap[item.Coil][item.Frequency]; !exists {
				targetMap[item.Coil][item.Frequency] = make(map[string]string)
			}

			targetMap[item.Coil][item.Frequency]["tx"] = item.Tx
			targetMap[item.Coil][item.Frequency]["rx"] = item.Rx
		}

		log.Printf("Running calibration with sine files: %+v and square files: %+v", sineFilePaths, squareFilePaths)

		// Create progress callback
		progressCallback := func(progress int) {
			conn.WriteJSON(struct {
				Type     string `json:"type"`
				Progress int    `json:"progress"`
			}{
				Type:     "calibrationProgress",
				Progress: progress,
			})
		}

		// Run calibration with RunCalibration instead of Calibrate
		results, err := calibration.RunCalibration(sineFilePaths, squareFilePaths, progressCallback)
		if err != nil {
			log.Printf("Calibration error: %v", err)
			conn.WriteJSON(Message{
				Type:    "error",
				Message: fmt.Sprintf("Calibration failed: %v", err),
			})
			return
		}

		log.Printf("Calibration completed, results: %+v", results)

		// Send the actual results
		conn.WriteJSON(struct {
			Type    string                                   `json:"type"`
			Results map[string]calibration.CalibrationResult `json:"results"`
		}{
			Type:    "calibrationResults",
			Results: results,
		})
	case "checkConfig":
		var configReq struct {
			Type string `json:"type"`
			Path string `json:"path"`
		}
		if err := json.Unmarshal(message, &configReq); err != nil {
			conn.WriteJSON(Message{
				Type:    "error",
				Message: "Invalid config check request",
			})
			return
		}

		// Check for config.csv in the directory
		configPath := filepath.Join(configReq.Path, "config.csv")
		config, err := readConfigFile(configPath)
		if err != nil {
			// If config file doesn't exist or has error, just return empty config
			log.Printf("No config file found at %s or error reading it: %v", configPath, err)
			conn.WriteJSON(struct {
				Type    string      `json:"type"`
				Station string      `json:"station"`
				Config  interface{} `json:"config"`
			}{
				Type:    "configData",
				Station: filepath.Base(configReq.Path),
				Config:  map[string]interface{}{},
			})
			return
		}

		// Send config data back to client
		conn.WriteJSON(struct {
			Type    string      `json:"type"`
			Station string      `json:"station"`
			Config  interface{} `json:"config"`
		}{
			Type:    "configData",
			Station: filepath.Base(configReq.Path),
			Config:  config,
		})
	case "calculateFIR":
		var firReq struct {
			Type string `json:"type"`
			Data []struct {
				Station       string  `json:"station"`
				FullPath      string  `json:"fullPath"`
				CoilName      string  `json:"coilName"`
				BaseFrequency float64 `json:"baseFrequency"`
				SampleRate    float64 `json:"sampleRate"`
				CoilChannel   string  `json:"coilChannel"`
			} `json:"data"`
		}

		if err := json.Unmarshal(message, &firReq); err != nil {
			log.Printf("Error unmarshaling FIR request: %v", err)
			conn.WriteJSON(Message{
				Type:    "error",
				Message: "Invalid FIR calculation request",
			})
			return
		}

		log.Printf("Processing FIR request with data: %+v", firReq.Data)

		// Process each FIR request sequentially
		for _, item := range firReq.Data {
			// Create progress callback
			progressCallback := func(progress int) {
				conn.WriteJSON(struct {
					Type     string `json:"type"`
					Station  string `json:"station"`
					Progress int    `json:"progress"`
				}{
					Type:     "firProgress",
					Station:  item.Station,
					Progress: progress,
				})
			}

			// Process FIR
			config := fir.FIRConfig{
				CoilName:      item.CoilName,
				BaseFrequency: item.BaseFrequency,
				SampleRate:    item.SampleRate,
				CoilChannel:   item.CoilChannel,
				FolderPath:    item.FullPath,
			}

			log.Printf("Processing FIR for station %s with config: %+v", item.Station, config)

			result, err := fir.ProcessFIR(config, progressCallback)
			if err != nil {
				log.Printf("Error processing FIR for %s: %v", item.Station, err)
				conn.WriteJSON(Message{
					Type:    "error",
					Message: fmt.Sprintf("Error processing FIR for %s: %v", item.Station, err),
				})
				continue
			}

			log.Printf("FIR processing completed for %s", item.Station)

			// Send completion message
			conn.WriteJSON(struct {
				Type    string      `json:"type"`
				Station string      `json:"station"`
				Results interface{} `json:"results"`
				Message string      `json:"message"`
			}{
				Type:    "firComplete",
				Station: item.Station,
				Results: result,
				Message: fmt.Sprintf("FIR coefficients saved to %s/fir_results/fir_coefficients_%s.csv",
					item.FullPath, item.CoilName),
			})
		}
	default:
		log.Printf("Received message: %+v\n", msg)
		response := Message{
			Type:    "response",
			Message: "Received " + msg.Type + " command",
		}
		if err := conn.WriteJSON(response); err != nil {
			log.Println("Write error:", err)
		}
	}
}

func listDirectory(path string) ([]FileInfo, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}

	var files []FileInfo
	for _, entry := range entries {
		fullPath := filepath.Join(path, entry.Name())
		files = append(files, FileInfo{
			Name:  entry.Name(),
			Path:  fullPath,
			IsDir: entry.IsDir(),
		})
	}
	return files, nil
}

// Add this helper function
func validateFilePaths(paths []string) ([]string, error) {
	var validPaths []string
	for _, path := range paths {
		// Check if the path is absolute, if not make it absolute
		if !filepath.IsAbs(path) {
			absPath, err := filepath.Abs(path)
			if err != nil {
				continue
			}
			path = absPath
		}

		// Verify file exists and is readable
		if _, err := os.Stat(path); err == nil {
			validPaths = append(validPaths, path)
		} else {
			log.Printf("Invalid file path: %s, error: %v", path, err)
		}
	}
	if len(validPaths) == 0 {
		return nil, fmt.Errorf("no valid files found in the provided paths")
	}
	return validPaths, nil
}

// Update the readConfigFile function
func readConfigFile(path string) (map[string]interface{}, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	// Parse CSV
	lines := strings.Split(string(data), "\n")
	if len(lines) < 2 {
		return nil, fmt.Errorf("invalid config file format")
	}

	// Parse headers and values
	headers := strings.Split(strings.TrimSpace(lines[0]), ",")
	values := strings.Split(strings.TrimSpace(lines[1]), ",")

	config := make(map[string]interface{})

	for i, header := range headers {
		if i >= len(values) {
			break
		}
		value := strings.TrimSpace(values[i])

		switch header {
		case "CoilName":
			config["coilName"] = value
		case "BaseFrequency":
			if f, err := strconv.ParseFloat(value, 64); err == nil {
				config["baseFrequency"] = f
			}
		case "SampleRate":
			if f, err := strconv.ParseFloat(value, 64); err == nil {
				config["sampleRate"] = f
			}
		case "CoilChannel":
			if ch, err := strconv.Atoi(value); err == nil {
				config["coilChannel"] = ch
			}
		}
	}

	log.Printf("Read config: %+v", config) // Debug log
	return config, nil
}
