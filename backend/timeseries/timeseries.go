package timeseries

import (
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"os"
)

func GetTotalFileLength(filePaths []string) (int64, error) {
	var totalLength int64

	for _, filePath := range filePaths {
		fileInfo, err := os.Stat(filePath)
		if err != nil {
			return 0, fmt.Errorf("error getting file info: %v", err)
		}
		totalLength += fileInfo.Size() / 4 // Assuming 4 bytes per float32
	}

	return totalLength, nil
}

func ReadAndDownsample(filePaths []string, startIndex, endIndex, decimationFactor int) ([]float64, []float64, error) {
	var allTimes []float64
	var allValues []float64

	// If the view range is small enough, don't decimate
	pointsInView := endIndex - startIndex
	if pointsInView < 10000 {
		decimationFactor = 1
	}

	for _, filePath := range filePaths {
		times, values, err := readBinaryFile(filePath, startIndex, endIndex)
		if err != nil {
			return nil, nil, err
		}
		allTimes = append(allTimes, times...)
		allValues = append(allValues, values...)
	}

	if decimationFactor <= 1 {
		return allTimes, allValues, nil
	}

	numPoints := len(allTimes)
	numSegments := (numPoints + decimationFactor - 1) / decimationFactor

	// Pre-allocate slices
	downsampledTimes := make([]float64, 0, numSegments*2)
	downsampledValues := make([]float64, 0, numSegments*2)

	for i := 0; i < numPoints; i += decimationFactor {
		endIdx := i + decimationFactor
		if endIdx > numPoints {
			endIdx = numPoints
		}

		// For each segment, find min, max, and any significant points
		segmentValues := allValues[i:endIdx]
		segmentTimes := allTimes[i:endIdx]

		// Always include first and last point in segment
		downsampledTimes = append(downsampledTimes, segmentTimes[0])
		downsampledValues = append(downsampledValues, segmentValues[0])

		// Find min and max within segment (excluding first and last points)
		if len(segmentValues) > 2 {
			minVal, maxVal := segmentValues[1], segmentValues[1]
			minIdx, maxIdx := 1, 1

			for j := 1; j < len(segmentValues)-1; j++ {
				if segmentValues[j] < minVal {
					minVal = segmentValues[j]
					minIdx = j
				}
				if segmentValues[j] > maxVal {
					maxVal = segmentValues[j]
					maxIdx = j
				}
			}

			// Add min and max points if they're different from first/last
			if minIdx != 0 && minIdx != len(segmentValues)-1 {
				downsampledTimes = append(downsampledTimes, segmentTimes[minIdx])
				downsampledValues = append(downsampledValues, minVal)
			}
			if maxIdx != 0 && maxIdx != len(segmentValues)-1 && maxIdx != minIdx {
				downsampledTimes = append(downsampledTimes, segmentTimes[maxIdx])
				downsampledValues = append(downsampledValues, maxVal)
			}
		}

		// Add last point in segment
		downsampledTimes = append(downsampledTimes, segmentTimes[len(segmentTimes)-1])
		downsampledValues = append(downsampledValues, segmentValues[len(segmentValues)-1])
	}

	return downsampledTimes, downsampledValues, nil
}

func readBinaryFile(filePath string, startIndex, endIndex int) ([]float64, []float64, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()

	fileInfo, err := file.Stat()
	if err != nil {
		return nil, nil, err
	}

	totalPoints := int(fileInfo.Size()) / 4 // Assuming 4 bytes per float32

	// Validate indices
	if startIndex < 0 {
		startIndex = 0
	}
	if endIndex <= 0 || endIndex > totalPoints {
		endIndex = totalPoints
	}
	if startIndex >= endIndex {
		return nil, nil, fmt.Errorf("invalid index range: start=%d, end=%d", startIndex, endIndex)
	}

	pointsToRead := endIndex - startIndex
	times := make([]float64, pointsToRead)
	values := make([]float64, pointsToRead)

	// Ensure we don't seek beyond file boundaries
	seekPos := int64(startIndex * 4)
	if seekPos >= fileInfo.Size() {
		return nil, nil, fmt.Errorf("seek position beyond file size")
	}

	_, err = file.Seek(seekPos, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("seek error: %v", err)
	}

	data := make([]byte, pointsToRead*4)
	n, err := file.Read(data)
	if err != nil && err != io.EOF {
		return nil, nil, err
	}

	// Adjust pointsToRead if we read less than expected
	actualPoints := n / 4
	if actualPoints < pointsToRead {
		pointsToRead = actualPoints
		times = times[:actualPoints]
		values = values[:actualPoints]
	}

	for i := 0; i < pointsToRead; i++ {
		value := math.Float32frombits(binary.LittleEndian.Uint32(data[i*4 : (i+1)*4]))
		times[i] = float64(startIndex + i)
		values[i] = float64(value)
	}

	return times, values, nil
}
