package fir

import (
	"encoding/binary"
	"encoding/csv"
	"fmt"
	"image/color"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"gonum.org/v1/gonum/mat"
	"gonum.org/v1/plot"
	"gonum.org/v1/plot/plotter"
	"gonum.org/v1/plot/vg"
)

type FIRConfig struct {
	CoilName      string
	BaseFrequency float64
	SampleRate    float64
	CoilChannel   string
	FolderPath    string
}

type FIRResult struct {
	FIRCoefficients []float64
	Plots           []string
	OutputDir       string
	Timestamp       string
}

func ProcessFIR(config FIRConfig, progressCallback func(int)) (*FIRResult, error) {
	// Get current timestamp
	timestamp := time.Now().Format("2006-01-02_15-04-05")

	// Use the folder path directly
	outputDir := config.FolderPath

	progressCallback(10)

	// Input parameters
	coilFilePath := filepath.Join(config.FolderPath, config.CoilChannel)
	nSamples := 2048

	fmt.Println("Starting signal processing...")

	// Parse binary data and process signals
	dataCoil, err := parseBinaryData(coilFilePath)
	if err != nil {
		return nil, fmt.Errorf("error reading coil data: %v", err)
	}
	progressCallback(30)

	// Remove dataCM since we don't need it
	progressCallback(50)

	// Process signals
	stackedCoilWaveform := stackAndResample(dataCoil, config.SampleRate, config.BaseFrequency, nSamples)
	perfectSquare := generatePerfectSquareWave(stackedCoilWaveform)

	progressCallback(70)

	// Calculate FIR coefficients and apply filter
	firCoefficients := regularizedLeastSquares(stackedCoilWaveform, perfectSquare)
	filteredSignal := applyFIRFilter(stackedCoilWaveform, firCoefficients)

	progressCallback(80)

	// Save only the essential files
	// 1. FIR coefficients CSV
	coeffFileName := fmt.Sprintf("fir_coefficients_%s_%s.csv", config.CoilName, timestamp)
	if err := saveFIRCoefficients(firCoefficients, coeffFileName, outputDir); err != nil {
		return nil, fmt.Errorf("error saving FIR coefficients: %v", err)
	}

	// 2. & 3. Save the two important plots
	plotFiles := []string{
		fmt.Sprintf("stacked_coil_waveform_%s.png", timestamp),
		fmt.Sprintf("filtered_signal_%s.png", timestamp),
	}

	if err := saveImportantPlots(outputDir, timestamp, stackedCoilWaveform, filteredSignal); err != nil {
		return nil, fmt.Errorf("error creating plots: %v", err)
	}

	progressCallback(100)

	return &FIRResult{
		FIRCoefficients: firCoefficients,
		Plots:           plotFiles,
		OutputDir:       outputDir,
		Timestamp:       timestamp,
	}, nil
}

func saveArrayToCSV(data []float64, filename string) error {
	file, err := os.Create(filename)
	if err != nil {
		return fmt.Errorf("failed to create file %s: %v", filename, err)
	}
	defer file.Close()

	writer := csv.NewWriter(file)
	defer writer.Flush()

	// Write header
	if err := writer.Write([]string{"Index", "Value"}); err != nil {
		return fmt.Errorf("failed to write header: %v", err)
	}

	// Write data
	for i, val := range data {
		if err := writer.Write([]string{
			strconv.Itoa(i),
			strconv.FormatFloat(val, 'f', -1, 64),
		}); err != nil {
			return fmt.Errorf("failed to write row %d: %v", i, err)
		}
	}

	return nil
}

func saveToeplitzMatrixToCSV(m *mat.Dense, filename string) error {
	rows, cols := m.Dims()

	file, err := os.Create(filename)
	if err != nil {
		return fmt.Errorf("failed to create file %s: %v", filename, err)
	}
	defer file.Close()

	writer := csv.NewWriter(file)
	defer writer.Flush()

	// Write each row
	for i := 0; i < rows; i++ {
		rowData := make([]string, cols)
		for j := 0; j < cols; j++ {
			rowData[j] = strconv.FormatFloat(m.At(i, j), 'f', -1, 64)
		}
		if err := writer.Write(rowData); err != nil {
			return fmt.Errorf("failed to write row %d: %v", i, err)
		}
	}

	return nil
}

func parseBinaryData(filePath string) ([]float64, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("error reading file: %v", err)
	}

	numFloats := len(data) / 4 // 4 bytes per float32
	result := make([]float64, numFloats)

	for i := 0; i < numFloats; i++ {
		bits := binary.LittleEndian.Uint32(data[i*4 : (i+1)*4])
		result[i] = float64(math.Float32frombits(bits))
	}

	return result, nil
}

func stackAndResample(data []float64, sampleRate, waveFrequency float64, nSamples int) []float64 {
	samplesPerCycle := int(sampleRate / waveFrequency)

	// Calculate mean for zero-crossing detection
	mean := 0.0
	for _, v := range data {
		mean += v
	}
	mean /= float64(len(data))

	// Find zero crossings
	var zeroCrossings []int
	for i := 0; i < len(data)-1; i++ {
		if (data[i]-mean)*(data[i+1]-mean) < 0 {
			zeroCrossings = append(zeroCrossings, i)
		}
	}

	// Stack cycles
	var stackedCycles [][]float64
	for i := 0; i < len(zeroCrossings)-1; i += 2 {
		if zeroCrossings[i]+samplesPerCycle >= len(data) {
			continue
		}
		cycle := make([]float64, samplesPerCycle)
		copy(cycle, data[zeroCrossings[i]:zeroCrossings[i]+samplesPerCycle])
		stackedCycles = append(stackedCycles, cycle)
	}

	// Average cycles
	representativeCycle := make([]float64, samplesPerCycle)
	for i := 0; i < samplesPerCycle; i++ {
		sum := 0.0
		for j := 0; j < len(stackedCycles); j++ {
			sum += stackedCycles[j][i]
		}
		representativeCycle[i] = sum / float64(len(stackedCycles))
	}

	// Resample to desired number of points
	resampledCycle := make([]float64, nSamples)
	for i := range resampledCycle {
		t := float64(i) / float64(nSamples-1)
		idx := t * float64(len(representativeCycle)-1)
		idxLow := int(math.Floor(idx))
		idxHigh := int(math.Ceil(idx))
		if idxHigh >= len(representativeCycle) {
			idxHigh = len(representativeCycle) - 1
		}
		fraction := idx - float64(idxLow)
		resampledCycle[i] = representativeCycle[idxLow]*(1-fraction) +
			representativeCycle[idxHigh]*fraction
	}

	return resampledCycle
}

func generatePerfectSquareWave(signal []float64) []float64 {
	n := len(signal)
	result := make([]float64, n)

	// Find the average of positive and negative peaks to determine amplitude
	maxVal := -math.MaxFloat64
	minVal := math.MaxFloat64
	for _, v := range signal {
		if v > maxVal {
			maxVal = v
		}
		if v < minVal {
			minVal = v
		}
	}

	amplitude := (maxVal - minVal) / 2
	offset := (maxVal + minVal) / 2

	// Generate square wave with matching amplitude
	for i := range result {
		if float64(i)/float64(n) < 0.5 {
			result[i] = offset + amplitude
		} else {
			result[i] = offset - amplitude
		}
	}

	return result
}

func createToeplitzMatrix(signal []float64) *mat.Dense {
	n := len(signal)
	data := make([]float64, n*n)

	// Create matrix where each row is a cyclic shift of the signal
	for i := 0; i < n; i++ {
		for j := 0; j < n; j++ {
			// Calculate the rolled index
			idx := (j + i) % n
			data[i*n+j] = signal[idx]
		}
	}

	return mat.NewDense(n, n, data)
}

func regularizedLeastSquares(imperfect, perfect []float64) []float64 {
	n := len(imperfect)

	// Create A matrix (Toeplitz)
	A := createToeplitzMatrix(imperfect)
	b := mat.NewVecDense(n, perfect)

	// Compute A^T
	AT := mat.DenseCopyOf(A.T())

	// Compute A^T * A
	var ATA mat.Dense
	ATA.Mul(AT, A)

	// Calculate mean of diagonal elements
	avgDiag := 0.0
	for i := 0; i < n; i++ {
		avgDiag += ATA.At(i, i)
	}
	avgDiag /= float64(n)

	// Add regularization (avgDiag * regularization_param * I)
	regParam := 0.000001
	for i := 0; i < n; i++ {
		ATA.Set(i, i, ATA.At(i, i)+avgDiag*regParam)
	}

	// Compute A^T * b
	var ATb mat.VecDense
	ATb.MulVec(AT, b)

	// Solve the system (ATA)x = ATb
	var x mat.VecDense
	if err := x.SolveVec(&ATA, &ATb); err != nil {
		panic(fmt.Sprintf("Failed to solve system: %v", err))
	}

	// Extract results
	result := make([]float64, n)
	for i := 0; i < n; i++ {
		result[i] = x.AtVec(i)
	}

	return result
}

func applyFIRFilter(signal, coeffs []float64) []float64 {
	N := len(signal)
	filtered := make([]float64, N)

	for i := 0; i < N; i++ {
		// Create rolled signal for this iteration
		rolledSignal := make([]float64, N)
		// Implement np.roll(signal, -i)
		for j := 0; j < N; j++ {
			// Calculate rolled index with negative shift
			idx := (j - i + N) % N
			rolledSignal[j] = signal[idx]
		}

		// Compute dot product (equivalent to np.dot)
		sum := 0.0
		for j := 0; j < N; j++ {
			sum += coeffs[j] * rolledSignal[j]
		}
		filtered[i] = sum
	}

	return filtered
}

func calculateBField(current, wrapSpacing float64) float64 {
	mu0 := 4 * math.Pi * 1e-7 // Permeability of free space (T·m/A)
	n := 1 / wrapSpacing      // Number of turns per unit length
	return mu0 * n * current
}

func saveFIRCoefficients(coeffs []float64, filename string, outputDir string) error {
	file, err := os.Create(filepath.Join(outputDir, filename))
	if err != nil {
		return err
	}
	defer file.Close()

	writer := csv.NewWriter(file)
	defer writer.Flush()

	if err := writer.Write([]string{"Index", "Coefficient"}); err != nil {
		return err
	}

	for i, coeff := range coeffs {
		if err := writer.Write([]string{
			strconv.Itoa(i),
			strconv.FormatFloat(coeff, 'f', -1, 64),
		}); err != nil {
			return err
		}
	}

	return nil
}

func saveImportantPlots(outputDir, timestamp string, stackedCoil, filteredSignal []float64) error {
	plots := []struct {
		data     []float64
		title    string
		filename string
	}{
		{stackedCoil, "Stacked Coil Waveform", fmt.Sprintf("stacked_coil_waveform_%s", timestamp)},
		{filteredSignal, "Filtered Signal", fmt.Sprintf("filtered_signal_%s", timestamp)},
	}

	for _, plotData := range plots {
		p := plot.New()
		p.Title.Text = plotData.title

		pts := make(plotter.XYs, len(plotData.data))
		for i := range pts {
			pts[i].X = float64(i)
			pts[i].Y = plotData.data[i]
		}

		line, err := plotter.NewLine(pts)
		if err != nil {
			return err
		}

		if plotData.title == "Filtered Signal" {
			line.Color = color.RGBA{R: 148, G: 0, B: 211, A: 255}
		} else {
			line.Color = color.RGBA{R: 0, G: 0, B: 255, A: 255}
		}

		p.Add(line)
		p.Add(plotter.NewGrid())

		if err := p.Save(8*vg.Inch, 6*vg.Inch, filepath.Join(outputDir, plotData.filename+".png")); err != nil {
			return err
		}
	}

	return nil
}
