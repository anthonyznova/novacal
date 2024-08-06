package timeseries

import (
	"encoding/binary"
	"fmt"
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

	// Downsample using the provided decimationFactor
	downsampledTimes := make([]float64, 0, len(allTimes)/decimationFactor+1)
	downsampledValues := make([]float64, 0, len(allValues)/decimationFactor+1)

	for i := 0; i < len(allTimes); i += decimationFactor {
		endIdx := i + decimationFactor
		if endIdx > len(allTimes) {
			endIdx = len(allTimes)
		}

		segment := allValues[i:endIdx]
		minVal, maxVal := segment[0], segment[0]
		minIdx, maxIdx := i, i

		for j, v := range segment {
			if v < minVal {
				minVal = v
				minIdx = i + j
			}
			if v > maxVal {
				maxVal = v
				maxIdx = i + j
			}
		}

		if minIdx < maxIdx {
			downsampledTimes = append(downsampledTimes, allTimes[minIdx], allTimes[maxIdx])
			downsampledValues = append(downsampledValues, minVal, maxVal)
		} else {
			downsampledTimes = append(downsampledTimes, allTimes[maxIdx], allTimes[minIdx])
			downsampledValues = append(downsampledValues, maxVal, minVal)
		}
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
	if endIndex == 0 || endIndex > totalPoints {
		endIndex = totalPoints
	}

	pointsToRead := endIndex - startIndex
	times := make([]float64, pointsToRead)
	values := make([]float64, pointsToRead)

	_, err = file.Seek(int64(startIndex*4), 0)
	if err != nil {
		return nil, nil, err
	}

	data := make([]byte, pointsToRead*4)
	_, err = file.Read(data)
	if err != nil {
		return nil, nil, err
	}

	for i := 0; i < pointsToRead; i++ {
		value := math.Float32frombits(binary.LittleEndian.Uint32(data[i*4 : (i+1)*4]))
		times[i] = float64(startIndex + i)
		values[i] = float64(value)
	}

	return times, values, nil
}
