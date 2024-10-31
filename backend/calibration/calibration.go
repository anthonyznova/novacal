package calibration

import (
	"fmt"
	"log"
	"math"
	"math/cmplx"
	"os"
	"sort"
	"sync"

	"gonum.org/v1/gonum/dsp/fourier"
	"gonum.org/v1/gonum/floats"
	"gonum.org/v1/gonum/stat"
)

// Global variables
var (
	AllFreqs             [][]float64
	AllTransferFunctions [][]complex128
	AllCoilData          map[string]*CoilData
)

// Initialize AllCoilData map
func init() {
	AllCoilData = make(map[string]*CoilData)
}

// Struct definitions
type CoilData struct {
	Freqs             [][]float64
	TransferFunctions [][]complex128
}

type CalibrationResult struct {
	Frequencies []float64
	Amplitudes  []float64
	Phases      []float64
}

type PlotlyData struct {
	X    []float64 `json:"x"`
	Y    []float64 `json:"y"`
	Type string    `json:"type"`
	Mode string    `json:"mode"`
	Name string    `json:"name"`
}

// Helper type for sorting
type sortedComplexSlice struct {
	freqs []float64
	tf    []complex128
}

func (s sortedComplexSlice) Len() int           { return len(s.freqs) }
func (s sortedComplexSlice) Less(i, j int) bool { return s.freqs[i] < s.freqs[j] }
func (s sortedComplexSlice) Swap(i, j int) {
	s.freqs[i], s.freqs[j] = s.freqs[j], s.freqs[i]
	s.tf[i], s.tf[j] = s.tf[j], s.tf[i]
}

// Main calibration function
func RunCalibration(sineFilePaths, squareFilePaths map[string]map[float64]map[string]string, progressCallback func(int)) (map[string]CalibrationResult, error) {
	const sampleRate = 51200.0

	// Reset global data
	AllCoilData = make(map[string]*CoilData)

	// Count total stations
	totalStations := 0
	for _, coilPaths := range sineFilePaths {
		totalStations += len(coilPaths)
	}
	for _, coilPaths := range squareFilePaths {
		totalStations += len(coilPaths)
	}

	// Create channels for synchronization
	var wg sync.WaitGroup
	errChan := make(chan error, totalStations)
	progressChan := make(chan int, totalStations)
	var processedStations int
	var progressMutex sync.Mutex

	// Process coils
	processCoil := func(coil string, freq float64, paths map[string]string, isSquare bool) {
		defer wg.Done()
		var err error
		if isSquare {
			err = processSquareWave(coil, freq, paths["tx"], paths["rx"], sampleRate)
		} else {
			err = processSineWave(coil, freq, paths["tx"], paths["rx"], sampleRate)
		}
		if err != nil {
			errChan <- fmt.Errorf("error processing %s wave for coil %s: %v",
				map[bool]string{true: "square", false: "sine"}[isSquare], coil, err)
		}
		progressMutex.Lock()
		processedStations++
		progress := int((float64(processedStations) / float64(totalStations)) * 100)
		progressMutex.Unlock()
		progressChan <- progress
	}

	// Process sine waves
	for coil, coilPaths := range sineFilePaths {
		for freq, paths := range coilPaths {
			wg.Add(1)
			go processCoil(coil, freq, paths, false)
		}
	}

	// Process square waves
	for coil, coilPaths := range squareFilePaths {
		for freq, paths := range coilPaths {
			wg.Add(1)
			go processCoil(coil, freq, paths, true)
		}
	}

	// Handle progress updates
	go func() {
		for progress := range progressChan {
			progressCallback(progress)
		}
	}()

	// Wait for all processing to complete
	wg.Wait()
	close(errChan)
	close(progressChan)

	// Check for errors
	for err := range errChan {
		if err != nil {
			return nil, err
		}
	}

	// Calculate final response
	return CalculateFinalResponse()
}

// Add these missing functions
func processSineWave(coil string, freq float64, txPath, rxPath string, sampleRate float64) error {
	log.Printf("Processing sine wave: coil=%s, freq=%f, tx=%s, rx=%s", coil, freq, txPath, rxPath)
	txSignal, err := readBinaryFile(txPath)
	if err != nil {
		return fmt.Errorf("error reading tx file %s: %v", txPath, err)
	}

	rxSignal, err := readBinaryFile(rxPath)
	if err != nil {
		return fmt.Errorf("error reading rx file %s: %v", rxPath, err)
	}

	validFreqs, transferFunction := CalculateSineTransferFunction(txSignal, rxSignal, sampleRate, freq)

	coilDataMutex.Lock()
	if _, exists := AllCoilData[coil]; !exists {
		AllCoilData[coil] = &CoilData{}
	}
	AllCoilData[coil].Freqs = append(AllCoilData[coil].Freqs, validFreqs)
	AllCoilData[coil].TransferFunctions = append(AllCoilData[coil].TransferFunctions, transferFunction)
	coilDataMutex.Unlock()

	log.Printf("Processed sine wave for frequency %.3f Hz (Coil: %s)", freq, coil)
	return nil
}

func processSquareWave(coil string, freq float64, txPath, rxPath string, sampleRate float64) error {
	log.Printf("Processing square wave: coil=%s, freq=%f, tx=%s, rx=%s", coil, freq, txPath, rxPath)
	txSignal, err := readBinaryFile(txPath)
	if err != nil {
		return fmt.Errorf("error reading tx file %s: %v", txPath, err)
	}

	rxSignal, err := readBinaryFile(rxPath)
	if err != nil {
		return fmt.Errorf("error reading rx file %s: %v", rxPath, err)
	}

	validFreqs, transferFunction, _, _, _ := CalculateTransferFunction(txSignal, rxSignal, sampleRate)

	coilDataMutex.Lock()
	if _, exists := AllCoilData[coil]; !exists {
		AllCoilData[coil] = &CoilData{}
	}
	AllCoilData[coil].Freqs = append(AllCoilData[coil].Freqs, validFreqs)
	AllCoilData[coil].TransferFunctions = append(AllCoilData[coil].TransferFunctions, transferFunction)
	coilDataMutex.Unlock()

	log.Printf("Processed square wave for frequency %.3f Hz (Coil: %s)", freq, coil)
	return nil
}

func CalculateFinalResponse() (map[string]CalibrationResult, error) {
	result := make(map[string]CalibrationResult)

	for coil, coilData := range AllCoilData {
		var allFreqsFlat []float64
		var allTransferFunctionsFlat []complex128

		for _, freqs := range coilData.Freqs {
			allFreqsFlat = append(allFreqsFlat, freqs...)
		}
		for _, tf := range coilData.TransferFunctions {
			allTransferFunctionsFlat = append(allTransferFunctionsFlat, tf...)
		}

		if len(allFreqsFlat) == 0 || len(allTransferFunctionsFlat) == 0 {
			return nil, fmt.Errorf("no data for coil %s", coil)
		}

		sort.Sort(sortedComplexSlice{allFreqsFlat, allTransferFunctionsFlat})

		amplitudes := make([]float64, len(allTransferFunctionsFlat))
		phases := make([]float64, len(allTransferFunctionsFlat))

		for i, tf := range allTransferFunctionsFlat {
			amplitudes[i] = 20 * math.Log10(cmplx.Abs(tf))
			phases[i] = cmplx.Phase(tf) * 180 / math.Pi
		}

		phases = unwrapPhase(phases)

		meanPhase := stat.Mean(phases, nil)
		for i := range phases {
			phases[i] -= meanPhase
		}

		result[coil] = CalibrationResult{
			Frequencies: allFreqsFlat,
			Amplitudes:  amplitudes,
			Phases:      phases,
		}
	}

	if len(result) == 0 {
		return nil, fmt.Errorf("no calibration results calculated")
	}

	return result, nil
}

// Add mutex for thread safety
var coilDataMutex sync.Mutex

// Add these missing functions:

// readBinaryFile reads a binary file containing float32 values
func readBinaryFile(filePath string) ([]float64, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}

	floatData := make([]float64, len(data)/4)
	for i := 0; i < len(data); i += 4 {
		bits := uint32(data[i]) | uint32(data[i+1])<<8 | uint32(data[i+2])<<16 | uint32(data[i+3])<<24
		floatData[i/4] = float64(math.Float32frombits(bits))
	}

	return floatData, nil
}

// blackmanHarris generates a Blackman-Harris window
func blackmanHarris(N int) []float64 {
	a0 := 0.35875
	a1 := 0.48829
	a2 := 0.14128
	a3 := 0.01168
	window := make([]float64, N)
	for n := 0; n < N; n++ {
		window[n] = a0 - a1*math.Cos(2*math.Pi*float64(n)/float64(N-1)) +
			a2*math.Cos(4*math.Pi*float64(n)/float64(N-1)) -
			a3*math.Cos(6*math.Pi*float64(n)/float64(N-1))
	}
	return window
}

// findPeaks finds peaks in the data above a threshold
func findPeaks(data []float64, threshold float64) []int {
	var peaks []int
	for i := 1; i < len(data)-1; i++ {
		if data[i] > data[i-1] && data[i] > data[i+1] && data[i] > threshold {
			peaks = append(peaks, i)
		}
	}
	return peaks
}

// unwrapPhase unwraps phase angles to produce a continuous phase curve
func unwrapPhase(phases []float64) []float64 {
	unwrapped := make([]float64, len(phases))
	copy(unwrapped, phases)
	for i := 1; i < len(unwrapped); i++ {
		diff := unwrapped[i] - unwrapped[i-1]
		if diff > 180 {
			unwrapped[i] -= 360
		} else if diff < -180 {
			unwrapped[i] += 360
		}
	}
	return unwrapped
}

// CalculateTransferFunction calculates the transfer function between two signals
func CalculateTransferFunction(txSignal, rxSignal []float64, sampleRate float64) ([]float64, []complex128, []complex128, []complex128, []float64) {
	N := len(txSignal)
	T := 1.0 / sampleRate

	window := blackmanHarris(N)

	txSignalWindowed := make([]float64, N)
	rxSignalWindowed := make([]float64, N)
	for i := 0; i < N; i++ {
		txSignalWindowed[i] = txSignal[i] * window[i]
		rxSignalWindowed[i] = rxSignal[i] * window[i]
	}

	fft := fourier.NewFFT(N)
	txFFT := fft.Coefficients(nil, txSignalWindowed)
	rxFFT := fft.Coefficients(nil, rxSignalWindowed)

	freqs := make([]float64, N/2+1)
	for i := range freqs {
		freqs[i] = float64(i) / (float64(N) * T)
	}

	txMagnitude := make([]float64, len(txFFT))
	for i, v := range txFFT {
		txMagnitude[i] = cmplx.Abs(v)
	}

	peaks := findPeaks(txMagnitude, 0.04*floats.Max(txMagnitude))

	validFreqs := make([]float64, len(peaks))
	transferFunction := make([]complex128, len(peaks))
	for i, peak := range peaks {
		validFreqs[i] = freqs[peak]
		transferFunction[i] = rxFFT[peak] / txFFT[peak]
	}

	return validFreqs, transferFunction, txFFT, rxFFT, freqs
}

// CalculateSineTransferFunction calculates the transfer function for a sine wave
func CalculateSineTransferFunction(txSignal, rxSignal []float64, sampleRate, expectedFreq float64) ([]float64, []complex128) {
	N := len(txSignal)
	T := 1.0 / sampleRate
	t := make([]float64, N)
	for i := range t {
		t[i] = float64(i) * T
	}

	k := int(expectedFreq * float64(N) * T)
	txComplex := complex(0, 0)
	rxComplex := complex(0, 0)

	for i := 0; i < N; i++ {
		expTerm := cmplx.Exp(complex(0, -2*math.Pi*float64(k)*float64(i)/float64(N)))
		txComplex += complex(txSignal[i], 0) * expTerm
		rxComplex += complex(rxSignal[i], 0) * expTerm
	}

	txComplex *= 2.0 / complex(float64(N), 0)
	rxComplex *= 2.0 / complex(float64(N), 0)

	transferFunction := rxComplex / txComplex

	return []float64{expectedFreq}, []complex128{transferFunction}
}

// ... rest of your existing functions ...
